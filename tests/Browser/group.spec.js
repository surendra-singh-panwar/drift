import { test, expect } from '@playwright/test';

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream'] } });

async function visitor(browser, baseURL, contexts, errors) {
    const context = await browser.newContext({ baseURL, permissions: ['camera', 'microphone'] });
    contexts.push(context);
    await context.addInitScript(() => {
        window.__groupProbe = { peers: [], streams: [], operations: [] };
        const Native = RTCPeerConnection;
        window.RTCPeerConnection = class extends Native { constructor(...args) {
            super(...args); this.__probeId = window.__groupProbe.peers.length; window.__groupProbe.peers.push(this);
            for (const method of ['setLocalDescription', 'setRemoteDescription']) {
                const original = this[method].bind(this);
                this[method] = async (...values) => {
                    try { const result = await original(...values); window.__groupProbe.operations.push({ pc: this.__probeId, method, type: values[0]?.type }); return result; }
                    catch (e) { window.__groupProbe.operations.push({ pc: this.__probeId, method, error: e.name }); throw e; }
                };
            }
        } };
        const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async constraints => { const stream = await capture(constraints); window.__groupProbe.streams.push(stream); return stream; };
    });
    const page = await context.newPage();
    page.__meshTrace = [];
    const trace = data => { page.__meshTrace.push(data); if (page.__meshTrace.length > 120) page.__meshTrace.shift(); };
    const meta = d => ({ kind: d.kind, from: d.from?.slice(0,6), to: d.to?.slice(0,6), instance: d.instance?.slice(0,6), round: d.negotiation?.slice(0,6), sequence: d.sequence });
    page.on('request', r => { if (new URL(r.url()).pathname === '/chat/signal') trace({ out: meta(r.postDataJSON()) }); });
    page.on('response', r => { if (new URL(r.url()).pathname === '/chat/signal') trace({ ack: meta(r.request().postDataJSON()), status: r.status() }); });
    page.on('websocket', socket => socket.on('framereceived', f => {
        try { const e = JSON.parse(String(f.payload)); if (e.event === 'chat.updated') { const d = JSON.parse(e.data); if (d.type === 'signal') trace({ in: meta(d) }); } } catch {}
    }));
    const faults = { offline: false, terminating: false, expected: [] };
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => {
        if (m.type() !== 'error') return;
        if (faults.offline && /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|Failed to load resource|WebSocket.*(failed|closed)/i.test(m.text())) { faults.expected.push(m.text()); return; }
        if (faults.terminating && /status of 403 \(Forbidden\)/.test(m.text()) && m.location().url.endsWith('/chat/signal')) { faults.expected.push(m.text()); return; }
        errors.push(m.text());
        console.log('Unexpected group browser error:', m.text(), m.location().url);
    });
    page.on('requestfailed', r => {
        if (new URL(r.url()).pathname === '/chat/heartbeat') console.log('Group heartbeat transport failure:', r.failure()?.errorText);
    });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Start chat', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Group video chat', exact: true }).click();
    return { context, page, faults };
}
async function act(page, label, action) {
    const pending = page.waitForResponse(r => new URL(r.url()).pathname === '/chat/'+action);
    await page.getByRole('button', { name: label, exact: true }).click();
    const response = await pending;
    expect(response.status()).toBe(200);
    const result = await response.json();
    console.log('Group action', action, result.status, result.members?.length);
    return result;
}
async function probe(page) {
    return page.evaluate(async () => {
        const live = window.__groupProbe.peers.filter(p => p.connectionState !== 'closed');
        const flowing = [];
        for (const pc of live) {
            let audio = 0, video = 0;
            (await pc.getStats()).forEach(s => { if (s.type === 'inbound-rtp') { if ((s.kind || s.mediaType) === 'audio') audio += s.bytesReceived || 0; else video += s.framesDecoded || 0; } });
            flowing.push(pc.connectionState === 'connected' && audio > 0 && video > 0);
        }
        return { live: live.length, total: window.__groupProbe.peers.length, flowing, captures: window.__groupProbe.streams.length,
            activeIds: live.map(p => p.__probeId),
            states: live.map(p => ({ connection: p.connectionState, ice: p.iceConnectionState, local: p.localDescription?.type, remote: p.remoteDescription?.type })),
            mediaLive: window.__groupProbe.streams.at(-1)?.getTracks().every(t => t.readyState === 'live'),
            released: window.__groupProbe.streams.every(s => s.getTracks().every(t => t.readyState === 'ended')) && live.length === 0 };
    });
}
async function flow(page, count) {
    try {
        await expect.poll(async () => { const p = await probe(page); return p.live === count && p.flowing.every(Boolean); }, { timeout: 90_000, message: 'Every mesh edge must receive audio RTP and decoded video' }).toBe(true);
    } catch (failure) {
        console.log('Mesh failure', count, await probe(page), await page.locator('.group-peer-status').allTextContents(), await page.getByRole('alert').allTextContents());
        for (const context of page.context().browser().contexts()) for (const participant of context.pages()) {
            console.log('Mesh participant diagnostic', await participant.evaluate(() => ({
                id: JSON.parse(document.querySelector('#app').getAttribute('data-page')).props.channel.slice(-6),
                operations: window.__groupProbe.operations,
                states: window.__groupProbe.peers.map(p => ({ id: p.__probeId, state: p.connectionState, local: p.localDescription?.type, remote: p.remoteDescription?.type })),
            })), JSON.stringify(participant.__meshTrace));
        }
        throw failure;
    }
    await expect(page.locator('.group-participant[data-peer] video')).toHaveCount(count);
}
async function cleanup(contexts) {
    for (const c of contexts) for (const page of c.pages()) {
        const stop = page.getByRole('button', { name: 'Stop', exact: true });
        if (await stop.isEnabled().catch(() => false)) {
            const stopped = page.waitForResponse(r => new URL(r.url()).pathname === '/chat/stop', { timeout: 15_000 }).catch(() => null);
            await stop.click({ timeout: 2000 }).catch(() => {});
            await stopped;
        }
    }
    await Promise.all(contexts.map(c => c.close()));
}

test('four-person mesh preserves existing edges, messages, reports, Next group and Stop', async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const contexts = [], errors = [], users = [];
    try {
        for (let i = 0; i < 5; i++) users.push(await visitor(browser, baseURL, contexts, errors));
        const states = [];
        const established = users.map(() => []);
        for (let i = 0; i < 4; i++) {
            states.push(await act(users[i].page, 'Start chat', 'start'));
            for (let j = 0; j <= i; j++) {
                await flow(users[j].page, i);
                const current = (await probe(users[j].page)).activeIds;
                for (const previous of established[j]) expect(current).toContain(previous);
                established[j] = current;
            }
        }
        for (const user of users.slice(0, 4)) {
            await expect(user.page.getByText('4/8 participants', { exact: true })).toBeVisible();
            expect((await probe(user.page)).captures).toBe(1);
            expect((await probe(user.page)).live).toBe(3);
        }
        await act(users[4].page, 'Start chat', 'start');
        const fifth = await act(users[4].page, 'Next group', 'next');
        expect(fifth.room).not.toBe(states[0].room);
        await flow(users[4].page, 0);
        await users[0].page.getByRole('textbox', { name: 'Message', exact: true }).fill('Hello to all three group peers');
        await users[0].page.getByRole('button', { name: 'Send message', exact: true }).click();
        for (const u of users.slice(1, 4)) await expect(u.page.locator('.bubble', { hasText: 'Hello to all three group peers' })).toHaveCount(1);
        await expect(users[4].page.locator('.bubble')).toHaveCount(0);
        const target = users[0].page.locator(`[data-peer="${states[1].self}"]`);
        await target.getByRole('button', { name: 'Report', exact: true }).click();
        await users[0].page.getByRole('textbox', { name: 'Report reason' }).fill('Automated test report; no action requested');
        await act(users[0].page, 'Submit report', 'report');
        await expect(users[0].page.getByText(/Report received for moderator review/)).toBeVisible();
        for (const u of users.slice(0, 4)) await flow(u.page, 3);
        users.forEach(u => { u.faults.terminating = true; });
        const next = await act(users[0].page, 'Next group', 'next');
        expect(next.room).toBe(fifth.room);
        for (const u of [users[0], users[4]]) await flow(u.page, 1);
        expect((await probe(users[0].page)).captures).toBe(1);
        for (const [index, u] of users.slice(1, 4).entries()) {
            await flow(u.page, 2);
            for (const active of (await probe(u.page)).activeIds) expect(established[index + 1]).toContain(active);
        }
        await act(users[3].page, 'Stop', 'stop');
        await expect.poll(async () => (await probe(users[3].page)).released).toBe(true);
        for (const u of users.slice(1, 3)) await flow(u.page, 1);
        await act(users[1].page, 'Stop', 'stop');
        await flow(users[2].page, 0);
        expect((await probe(users[2].page)).mediaLive).toBe(true);
        await expect(users[2].page.getByText('Waiting for participants…', { exact: true })).toBeVisible();
        for (const u of [users[0], users[2], users[4]]) {
            await act(u.page, 'Stop', 'stop');
            await expect.poll(async () => (await probe(u.page)).released).toBe(true);
        }
        expect(errors).toEqual([]);
    } finally { await cleanup(contexts); }
});

test('group refresh, actual network recovery and expired member cleanup preserve remaining peers', async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const contexts = [], errors = [], users = [];
    try {
        for (let i = 0; i < 3; i++) { const u = await visitor(browser, baseURL, contexts, errors); users.push(u); await act(u.page, 'Start chat', 'start'); }
        for (const u of users) await flow(u.page, 2);
        const heartbeat = users[0].page.waitForResponse(r => new URL(r.url()).pathname === '/chat/heartbeat');
        await users[0].page.reload(); expect((await heartbeat).status()).toBe(200);
        await users[0].page.getByRole('button', { name: 'Enable camera and microphone', exact: true }).click();
        for (const u of users) await flow(u.page, 2);
        users[0].faults.offline = true;
        await users[0].context.setOffline(true);
        await expect(users[0].page.getByRole('button', { name: 'Next group', exact: true })).toBeDisabled();
        await users[0].context.setOffline(false);
        for (const u of users) await flow(u.page, 2);
        users[0].faults.offline = false;
        users.forEach(u => { u.faults.terminating = true; });
        await users[0].page.close();
        for (const u of users.slice(1)) {
            await expect(u.page.getByText('2/8 participants', { exact: true })).toBeVisible({ timeout: 75_000 });
            await flow(u.page, 1);
        }
        expect(errors).toEqual([]);
    } finally { await cleanup(contexts); }
});

test('blocking leaves only the blocker, closes old edges and keeps local capture', async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const contexts = [], errors = [];
    let a, b;
    try {
        a = await visitor(browser, baseURL, contexts, errors);
        b = await visitor(browser, baseURL, contexts, errors);
        const first = await act(a.page, 'Start chat', 'start');
        const second = await act(b.page, 'Start chat', 'start');
        for (const u of [a,b]) await flow(u.page, 1);
        const stableEdges = (await probe(a.page)).activeIds;
        a.faults.offline = true;
        await a.page.route('**/chat/heartbeat', route => route.abort('failed'));
        await a.page.waitForEvent('requestfailed', { predicate: r => new URL(r.url()).pathname === '/chat/heartbeat', timeout: 15_000 });
        await expect(a.page.getByRole('alert')).toContainText('Connection failed');
        await expect(a.page.getByRole('button', { name: 'Next group', exact: true })).toBeEnabled();
        expect((await probe(a.page)).activeIds).toEqual(stableEdges);
        await a.page.unroute('**/chat/heartbeat');
        a.faults.offline = false;
        // Recover on the existing connection without recapturing the camera.
        const initiator = first.self > second.self ? a : b;
        const previousTotal = (await probe(initiator.page)).total;
        const previousSdp = await initiator.page.evaluate(() => window.__groupProbe.peers.find(p => p.connectionState === 'connected').localDescription.sdp);
        await initiator.page.evaluate(() => {
            const pc = window.__groupProbe.peers.find(p => p.connectionState === 'connected');
            Object.defineProperty(pc, 'connectionState', { configurable: true, get: () => 'failed' });
            pc.dispatchEvent(new Event('connectionstatechange'));
            delete pc.connectionState;
        });
        await expect.poll(() => initiator.page.evaluate(() => window.__groupProbe.peers.find(p => p.connectionState !== 'closed').localDescription.sdp)).not.toBe(previousSdp);
        expect((await probe(initiator.page)).total).toBe(previousTotal);
        for (const u of [a,b]) await flow(u.page, 1);
        a.faults.terminating = b.faults.terminating = true;
        const blocked = await act(a.page, 'Block and leave', 'block');
        expect(blocked.room).not.toBe(first.room);
        for (const u of [a,b]) {
            await flow(u.page, 0);
            expect((await probe(u.page)).captures).toBe(1);
            expect((await probe(u.page)).mediaLive).toBe(true);
        }
        await expect(b.page.getByText('1/8 participants', { exact: true })).toBeVisible();
        const afterNext = await act(b.page, 'Next group', 'next');
        expect(afterNext.room).not.toBe(blocked.room);
        expect(afterNext.room).not.toBe(second.room);
        expect(errors).toEqual([]);
    } finally { await cleanup(contexts); }
});


test('a group ICE restart preserves every healthy edge and applies per-edge video budgets', async ({ browser, baseURL }) => {
    const contexts = [], errors = [], users = [];
    try {
        for (let i = 0; i < 3; i++) {
            const user = await visitor(browser, baseURL, contexts, errors); users.push(user);
            await act(user.page, 'Start chat', 'start');
        }
        for (const user of users) await flow(user.page, 2);
        const before = await Promise.all(users.map(user => probe(user.page)));
        for (const user of users) await user.page.evaluate(() => {
            window.__restartCount = 0;
            for (const pc of window.__groupProbe.peers.filter(pc => pc.connectionState === 'connected')) {
                const restart = pc.restartIce.bind(pc);
                pc.restartIce = () => { window.__restartCount++; return restart(); };
            }
        });
        await users[0].page.evaluate(() => {
            const pc = window.__groupProbe.peers.find(pc => pc.connectionState === 'connected');
            Object.defineProperty(pc, 'connectionState', { configurable: true, value: 'failed' });
            pc.dispatchEvent(new Event('connectionstatechange'));
            delete pc.connectionState;
        });
        await expect.poll(async () => (await Promise.all(users.map(user => user.page.evaluate(() => window.__restartCount)))).reduce((sum, count) => sum + count, 0)).toBe(1);
        for (const user of users) await expect.poll(() => user.page.evaluate(() =>
            window.__groupProbe.peers.filter(pc => pc.connectionState !== 'closed').every(pc => pc.signalingState === 'stable'),
        )).toBe(true);
        for (const user of users) await flow(user.page, 2);
        for (let i = 0; i < users.length; i++) expect((await probe(users[i].page)).activeIds).toEqual(before[i].activeIds);
        await expect.poll(() => users[0].page.evaluate(() => window.__groupProbe.peers.filter(pc => pc.connectionState === 'connected').every(pc => {
            const encodings = pc.getSenders().find(sender => sender.track?.kind === 'video').getParameters().encodings;
            return encodings.length && encodings.every(encoding => encoding.maxBitrate > 0 && encoding.maxBitrate <= 600000 && encoding.maxFramerate <= 20);
        })), { timeout: 20000 }).toBe(true);
        for (const user of users) expect((await probe(user.page)).captures).toBe(1);
        expect(errors).toEqual([]);
    } finally { await cleanup(contexts); }
});
