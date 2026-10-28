import { test, expect } from '@playwright/test';

// Chrome supplies synthetic camera/microphone devices, but signaling, codecs,
// ICE, DTLS, RTP, media tracks and RTCPeerConnection all run for real.
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream'] } });

async function observeMedia(context) {
    await context.addInitScript(() => {
        const probe = { connections: [], streams: [] };
        window.__driftMediaProbe = probe;
        const NativePeerConnection = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends NativePeerConnection {
            constructor(...args) { super(...args); probe.connections.push(this); }
        };
        const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async constraints => {
            const stream = await capture(constraints);
            probe.streams.push(stream);
            return stream;
        };
    });
}

async function mediaState(page) {
    return page.evaluate(async () => {
        const probe = window.__driftMediaProbe;
        const connections = probe.connections.filter(pc => pc.connectionState !== 'closed');
        const pc = connections.at(-1);
        const state = { peers: connections.length, connected: pc?.connectionState === 'connected', audioBytes: 0, videoBytes: 0, videoFrames: 0 };
        if (pc) {
            const stats = await pc.getStats();
            stats.forEach(report => {
                if (report.type !== 'inbound-rtp') return;
                const kind = report.kind || report.mediaType;
                if (kind === 'audio') state.audioBytes += report.bytesReceived || 0;
                if (kind === 'video') {
                    state.videoBytes += report.bytesReceived || 0;
                    state.videoFrames += report.framesDecoded || 0;
                }
            });
        }
        return state;
    });
}

async function expectMediaFlow(page) {
    await expect(page.getByText('Connected', { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect.poll(async () => {
        const state = await mediaState(page);
        return state.connected && state.peers === 1 && state.audioBytes > 0 && state.videoBytes > 0 && state.videoFrames > 0;
    }, { message: 'Real inbound audio RTP and decoded video frames must reach this browser', timeout: 45_000 }).toBe(true);
    await expect.poll(() => page.getByLabel('Stranger camera', { exact: true }).evaluate(video =>
        video.videoWidth > 0 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA,
    ), { message: 'The remote video element must display decoded frames' }).toBe(true);
    await expect(page.getByLabel('Your camera', { exact: true })).toHaveJSProperty('muted', true);
    const remote = await page.getByLabel('Stranger camera', { exact: true }).boundingBox();
    const local = await page.getByLabel('Your camera', { exact: true }).boundingBox();
    expect(remote.width).toBeGreaterThan(local.width);
}

async function expectReleased(page) {
    await expect.poll(() => page.evaluate(() => {
        const probe = window.__driftMediaProbe;
        return probe.streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'))
            && probe.connections.every(pc => pc.connectionState === 'closed');
    }), { message: 'Camera/microphone tracks must end and peer connections must close' }).toBe(true);
}

async function control(page, label, action) {
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === `/chat/${action}`);
    await page.getByRole('button', { name: label, exact: true }).click();
    const response = await pending;
    expect(response.status()).toBe(200);
    return response.json();
}

async function visitor(browser, baseURL, contexts, errors) {
    const context = await browser.newContext({ baseURL, permissions: ['camera', 'microphone'] });
    contexts.push(context);
    await observeMedia(context);
    const page = await context.newPage();
    const networkFault = { active: false, ending: false, expectedErrors: [] };
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
        if (message.type() !== 'error') return;
        const text = message.text();
        // Ending a room may race a peer's already-dispatched ICE/ready request.
        // The membership rejection is expected only on this endpoint and transition.
        if (networkFault.ending && /status of 403 \(Forbidden\)/.test(text)
            && message.location().url.endsWith('/chat/signal')) {
            networkFault.expectedErrors.push(text);
            return;
        }
        if (networkFault.active && /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|Failed to load resource|WebSocket.*(failed|closed)/i.test(text)) {
            networkFault.expectedErrors.push(text);
        } else errors.push(text);
    });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Start chat', exact: true })).toBeEnabled();
    return { context, page, networkFault };
}

async function cleanup(contexts) {
    for (const context of contexts) {
        for (const page of context.pages()) {
            if (page.isClosed()) continue;
            const stop = page.getByRole('button', { name: 'Stop', exact: true });
            if (await stop.isEnabled().catch(() => false)) {
                await stop.click({ timeout: 2000 }).catch(() => {});
            }
        }
    }
    await Promise.all(contexts.map(context => context.close()));
}

test('real two-way video/audio survives refresh and Next, and releases devices on Stop and peer close', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(180_000);
    const contexts = [];
    const errors = [];
    try {
        const a = await visitor(browser, baseURL, contexts, errors);
        const b = await visitor(browser, baseURL, contexts, errors);
        for (const page of [a.page, b.page]) await page.getByRole('button', { name: 'Video chat', exact: true }).click();
        expect((await control(a.page, 'Start chat', 'start')).status).toBe('searching');
        const match = await control(b.page, 'Start chat', 'start');
        expect(match.status).toBe('connected');
        expect(match.mode).toBe('video');
        for (const page of [a.page, b.page]) await expectMediaFlow(page);

        // Interrupt real browser networking while a call is active. The signaling
        // subscription must reauthorize and the actual RTP media must recover.
        a.networkFault.active = true;
        await a.context.setOffline(true);
        await expect(a.page.getByRole('button', { name: 'Next stranger', exact: true })).toBeDisabled();
        const reauthorized = a.page.waitForResponse(response => new URL(response.url()).pathname === '/broadcasting/auth');
        const recoveredHeartbeat = a.page.waitForResponse(response => new URL(response.url()).pathname === '/chat/heartbeat');
        await a.context.setOffline(false);
        expect((await reauthorized).status()).toBe(200);
        expect((await recoveredHeartbeat).status()).toBe(200);
        await expect(a.page.getByText('Chat service connected', { exact: true })).toBeVisible();
        for (const page of [a.page, b.page]) await expectMediaFlow(page);
        a.networkFault.active = false;
        await testInfo.attach('intentional-offline-network-errors', { body: JSON.stringify(a.networkFault.expectedErrors), contentType: 'application/json' });

        await a.page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
        expect(await a.page.evaluate(() => window.__driftMediaProbe.streams.at(-1).getAudioTracks()[0].enabled)).toBe(false);
        await a.page.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
        expect(await a.page.evaluate(() => window.__driftMediaProbe.streams.at(-1).getAudioTracks()[0].enabled)).toBe(true);
        await a.page.getByRole('button', { name: 'Turn camera off', exact: true }).click();
        expect(await a.page.evaluate(() => window.__driftMediaProbe.streams.at(-1).getVideoTracks()[0].enabled)).toBe(false);
        await a.page.getByRole('button', { name: 'Turn camera on', exact: true }).click();
        expect(await a.page.evaluate(() => window.__driftMediaProbe.streams.at(-1).getVideoTracks()[0].enabled)).toBe(true);

        await a.page.getByRole('textbox', { name: 'Message', exact: true }).fill('Text still works during a video call');
        await a.page.getByRole('button', { name: 'Send message', exact: true }).click();
        await expect(b.page.locator('.bubble', { hasText: 'Text still works during a video call' })).toHaveCount(1);

        const heartbeat = a.page.waitForResponse(response => new URL(response.url()).pathname === '/chat/heartbeat');
        await a.page.reload();
        const resumed = await heartbeat;
        expect(resumed.status()).toBe(200);
        expect((await resumed.json()).room).toBe(match.room);
        await a.page.getByRole('button', { name: 'Enable camera and microphone', exact: true }).click();
        for (const page of [a.page, b.page]) await expectMediaFlow(page);

        let releaseNext;
        a.networkFault.ending = b.networkFault.ending = true;
        const nextGate = new Promise(resolve => { releaseNext = resolve; });
        await a.page.route('**/chat/next', async route => { await nextGate; await route.continue(); });
        const nextResponse = a.page.waitForResponse(response => new URL(response.url()).pathname === '/chat/next');
        await a.page.getByRole('button', { name: 'Next stranger', exact: true }).click();
        await expect.poll(async () => (await mediaState(a.page)).peers).toBe(0);
        expect(await a.page.evaluate(() => window.__driftMediaProbe.streams.at(-1).getTracks().every(track => track.readyState === 'live'))).toBe(true);
        releaseNext();
        expect((await (await nextResponse).json()).status).toBe('searching');
        await a.page.unroute('**/chat/next');
        await expect(b.page.getByText('Stranger disconnected.', { exact: true })).toBeVisible();
        await expectReleased(b.page);
        const rematch = await control(b.page, 'Start chat', 'start');
        expect(rematch.room).not.toBe(match.room);
        expect(rematch.mode).toBe('video');
        for (const page of [a.page, b.page]) await expectMediaFlow(page);

        a.networkFault.ending = b.networkFault.ending = true;
        await control(a.page, 'Stop', 'stop');
        await expectReleased(a.page);
        await expect(b.page.getByText('Stranger disconnected.', { exact: true })).toBeVisible();
        await expectReleased(b.page);

        await control(a.page, 'Start chat', 'start');
        await control(b.page, 'Start chat', 'start');
        for (const page of [a.page, b.page]) await expectMediaFlow(page);
        a.networkFault.ending = b.networkFault.ending = true;
        await b.page.close();
        await expect(a.page.getByText('Stranger disconnected.', { exact: true })).toBeVisible({ timeout: 75_000 });
        await expectReleased(a.page);
        expect(errors, 'Video browsers must not have console errors or uncaught exceptions').toEqual([]);
    } finally {
        await testInfo.attach('video-browser-errors', { body: JSON.stringify(errors), contentType: 'application/json' });
        await cleanup(contexts);
    }
});

test('video visitors match only video visitors while text matchmaking stays available', async ({ browser, baseURL }) => {
    test.setTimeout(100_000);
    const contexts = [];
    const errors = [];
    try {
        const text = await visitor(browser, baseURL, contexts, errors);
        const videoA = await visitor(browser, baseURL, contexts, errors);
        const videoB = await visitor(browser, baseURL, contexts, errors);
        const waitingText = await control(text.page, 'Start chat', 'start');
        expect(waitingText.mode).toBe('text');
        for (const page of [videoA.page, videoB.page]) await page.getByRole('button', { name: 'Video chat', exact: true }).click();
        const waitingVideo = await control(videoA.page, 'Start chat', 'start');
        expect(waitingVideo.status).toBe('searching');
        expect(waitingVideo.mode).toBe('video');
        expect((await control(videoB.page, 'Start chat', 'start')).status).toBe('connected');
        for (const page of [videoA.page, videoB.page]) await expectMediaFlow(page);
        await expect(text.page.getByText('Looking for someone to chat with...')).toBeVisible();
        expect(await text.page.evaluate(() => window.__driftMediaProbe.streams.length)).toBe(0);
        expect(errors).toEqual([]);
    } finally { await cleanup(contexts); }
});

test('denied camera and microphone permissions never enter the video queue', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL });
    try {
        // Chromium's permission override rejects all media permissions for this origin.
        await context.grantPermissions([], { origin: new URL(baseURL).origin });
        await observeMedia(context);
        const page = await context.newPage();
        const starts = [];
        page.on('request', request => { if (new URL(request.url()).pathname === '/chat/start') starts.push(request); });
        await page.goto('/');
        await expect(page.getByRole('button', { name: 'Start chat', exact: true })).toBeEnabled();
        await page.getByRole('button', { name: 'Video chat', exact: true }).click();
        await page.getByRole('button', { name: 'Start chat', exact: true }).click();
        await expect(page.getByRole('alert')).toContainText(/camera|microphone|permission/i);
        await expect(page.getByRole('button', { name: 'Start chat', exact: true })).toBeEnabled();
        expect(starts).toHaveLength(0);
        expect(await page.evaluate(() => window.__driftMediaProbe.streams.length)).toBe(0);
    } finally { await context.close(); }
});

test('Stop cancels a pending media permission request and releases its eventual tracks', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, permissions: ['camera', 'microphone'] });
    try {
        await observeMedia(context);
        await context.addInitScript(() => {
            const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
            navigator.mediaDevices.getUserMedia = async constraints => {
                await new Promise(resolve => { window.__allowMedia = resolve; });
                return capture(constraints);
            };
        });
        const page = await context.newPage();
        const starts = [];
        page.on('request', request => { if (new URL(request.url()).pathname === '/chat/start') starts.push(request); });
        await page.goto('/');
        await expect(page.getByRole('button', { name: 'Start chat', exact: true })).toBeEnabled();
        await page.getByRole('button', { name: 'Video chat', exact: true }).click();
        await page.getByRole('button', { name: 'Start chat', exact: true }).click();
        await expect.poll(() => page.evaluate(() => typeof window.__allowMedia)).toBe('function');
        await control(page, 'Stop', 'stop');
        await page.evaluate(() => window.__allowMedia());
        await expect.poll(() => page.evaluate(() => window.__driftMediaProbe.streams.length)).toBe(1);
        await expectReleased(page);
        expect(starts).toHaveLength(0);
    } finally { await context.close(); }
});

test('Stop waits for an in-flight Start and device removal ends a waiting video session', async ({ browser, baseURL }) => {
    const contexts = [], errors = [];
    let releaseStart;
    const gate = new Promise(resolve => { releaseStart = resolve; });
    try {
        const { page } = await visitor(browser, baseURL, contexts, errors);
        await page.getByRole('button', { name: 'Video chat', exact: true }).click();
        let intercepted = false;
        await page.route('**/chat/start', async route => { intercepted = true; await gate; await route.continue(); });
        await page.getByRole('button', { name: 'Start chat', exact: true }).click();
        await expect.poll(() => intercepted).toBe(true);
        await page.getByRole('button', { name: 'Stop', exact: true }).click();
        await expectReleased(page);
        const stopped = page.waitForResponse(response => new URL(response.url()).pathname === '/chat/stop');
        releaseStart();
        expect((await (await stopped).json()).status).toBe('idle');
        await page.unroute('**/chat/start');
        await expect(page.getByRole('button', { name: 'Start chat', exact: true })).toBeEnabled();
        await control(page, 'Start chat', 'start');
        const deviceStopped = page.waitForResponse(response => new URL(response.url()).pathname === '/chat/stop');
        await page.evaluate(() => window.__driftMediaProbe.streams.at(-1).getAudioTracks()[0].dispatchEvent(new Event('ended')));
        expect((await (await deviceStopped).json()).status).toBe('idle');
        await expectReleased(page);
        await expect(page.getByRole('alert')).toContainText('camera or microphone stopped');
        expect(errors).toEqual([]);
    } finally { releaseStart(); await cleanup(contexts); }
});


test('text visitors defer video modules until a video mode is selected', async ({ page }) => {
    const scripts = [];
    page.on('request', request => { if (request.resourceType() === 'script') scripts.push(request.url()); });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Start chat', exact: true })).toBeEnabled();
    expect(scripts.some(url => /VideoRuntime|VideoPanel|use-video-call|GroupVideoPanel/.test(url))).toBe(false);
    await page.getByRole('button', { name: 'Video chat', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Start chat', exact: true })).toBeEnabled();
    expect(scripts.some(url => /use-video-call/.test(url))).toBe(true);
});

async function induceFailure(page, delayedOffer = false) {
    await page.evaluate(delayed => {
        const pc = window.__driftMediaProbe.connections.filter(pc => pc.connectionState !== 'closed').at(-1);
        const offer = pc.createOffer.bind(pc);
        if (delayed) pc.createOffer = async options => {
            window.__restartWaiting = true;
            await new Promise(resolve => { window.__releaseRestart = resolve; });
            return offer(options);
        };
        Object.defineProperty(pc, 'connectionState', { configurable: true, value: 'failed' });
        pc.dispatchEvent(new Event('connectionstatechange'));
        delete pc.connectionState;
    }, delayedOffer);
}

async function captureIncomingSignals(page) {
    await page.evaluate(() => {
        window.__capturedSignals = [];
        const channel = JSON.parse(document.querySelector('#app').getAttribute('data-page')).props.channel;
        window.Pusher.instances[0].channel('private-' + channel).bind('chat.updated', data => {
            if (data.type === 'signal') window.__capturedSignals.push(data);
        });
    });
}

test('a short peer interruption is shown and clears when the existing connection recovers', async ({ browser, baseURL }) => {
    const contexts = [], errors = [];
    try {
        const a = await visitor(browser, baseURL, contexts, errors);
        const b = await visitor(browser, baseURL, contexts, errors);
        for (const user of [a, b]) await user.page.getByRole('button', { name: 'Video chat', exact: true }).click();
        await control(a.page, 'Start chat', 'start');
        await control(b.page, 'Start chat', 'start');
        await expectMediaFlow(b.page);

        await b.page.evaluate(() => {
            const pc = window.__driftMediaProbe.connections.at(-1);
            Object.defineProperty(pc, 'connectionState', { configurable: true, value: 'disconnected' });
            pc.dispatchEvent(new Event('connectionstatechange'));
        });
        await expect(b.page.getByText('Connection interrupted', { exact: true })).toBeVisible();
        await b.page.evaluate(() => {
            const pc = window.__driftMediaProbe.connections.at(-1);
            delete pc.connectionState;
            pc.dispatchEvent(new Event('connectionstatechange'));
        });
        await expect(b.page.getByText('Connected', { exact: true })).toBeVisible();
        expect(errors).toEqual([]);
    } finally { await cleanup(contexts); }
});

test('ICE restart keeps the same peer and ignores delayed previous negotiation packets', async ({ browser, baseURL }) => {
    const contexts = [], errors = [];
    try {
        const a = await visitor(browser, baseURL, contexts, errors);
        const b = await visitor(browser, baseURL, contexts, errors);
        for (const user of [a, b]) { await captureIncomingSignals(user.page); await user.page.getByRole('button', { name: 'Video chat', exact: true }).click(); }
        await control(a.page, 'Start chat', 'start');
        const match = await control(b.page, 'Start chat', 'start');
        for (const user of [a, b]) await expectMediaFlow(user.page);
        const oldUfrag = await b.page.evaluate(() => window.__driftMediaProbe.connections.at(-1).localDescription.sdp.match(/a=ice-ufrag:(.+)/)[1]);
        await induceFailure(b.page);
        await expect.poll(() => b.page.evaluate(() => window.__driftMediaProbe.connections.at(-1).localDescription.sdp.match(/a=ice-ufrag:(.+)/)[1])).not.toBe(oldUfrag);
        for (const user of [a, b]) await expect.poll(() => user.page.evaluate(() => {
            const pc = window.__driftMediaProbe.connections.at(-1);
            return pc.signalingState === 'stable' && ['connected', 'completed'].includes(pc.iceConnectionState);
        })).toBe(true);
        for (const user of [a, b]) await expectMediaFlow(user.page);
        const frames = (await mediaState(a.page)).videoFrames;
        await expect.poll(async () => (await mediaState(a.page)).videoFrames).toBeGreaterThan(frames);
        for (const user of [a, b]) {
            expect(await user.page.evaluate(() => window.__driftMediaProbe.connections.length)).toBe(1);
            await user.page.evaluate(() => {
                const signals = window.__capturedSignals;
                const channel = JSON.parse(document.querySelector('#app').getAttribute('data-page')).props.channel;
                const socket = window.Pusher.instances[0].channel('private-' + channel);
                for (const packet of signals.filter(data => data.negotiation === signals.find(data => data.kind === 'offer' || data.kind === 'answer')?.negotiation)) socket.emit('chat.updated', packet);
            });
            await expectMediaFlow(user.page);
        }
        await b.page.getByRole('textbox', { name: 'Message', exact: true }).fill('Same room after ICE restart');
        await b.page.getByRole('button', { name: 'Send message', exact: true }).click();
        await expect(a.page.locator('.bubble', { hasText: 'Same room after ICE restart' })).toHaveCount(1);
        const heartbeat = b.page.waitForResponse(response => response.url().endsWith('/chat/heartbeat'));
        expect((await (await heartbeat).json()).room).toBe(match.room);
        expect(errors).toEqual([]);
    } finally { await cleanup(contexts); }
});

test('Next and Stop cancel an ICE restart even when createOffer resolves late', async ({ browser, baseURL }) => {
    const contexts = [], errors = [];
    try {
        const a = await visitor(browser, baseURL, contexts, errors);
        const b = await visitor(browser, baseURL, contexts, errors);
        for (const user of [a, b]) await user.page.getByRole('button', { name: 'Video chat', exact: true }).click();
        for (const action of ['next', 'stop']) {
            await control(a.page, 'Start chat', 'start');
            await control(b.page, 'Start chat', 'start');
            for (const user of [a, b]) await expectMediaFlow(user.page);
            const offers = [];
            const listener = request => { if (request.url().endsWith('/chat/signal') && request.postDataJSON().kind === 'offer') offers.push(request); };
            b.page.on('request', listener);
            await induceFailure(b.page, true);
            await expect.poll(() => b.page.evaluate(() => !!window.__restartWaiting)).toBe(true);
            a.networkFault.ending = b.networkFault.ending = true;
            await control(b.page, action === 'next' ? 'Next stranger' : 'Stop', action);
            await b.page.evaluate(() => { window.__releaseRestart(); window.__restartWaiting = false; });
            await expect.poll(async () => (await mediaState(b.page)).peers).toBe(0);
            await b.page.waitForTimeout(1500);
            expect(offers).toHaveLength(0);
            b.page.off('request', listener);
            if (action === 'next') await control(b.page, 'Stop', 'stop');
            await expectReleased(b.page);
            await expectReleased(a.page);
        }
    } finally { await cleanup(contexts); }
});


test('automatic ICE retries stop after three failures and manual retry reuses camera capture', async ({ browser, baseURL }) => {
    test.setTimeout(110000);
    const contexts = [], errors = [];
    try {
        const a = await visitor(browser, baseURL, contexts, errors);
        const b = await visitor(browser, baseURL, contexts, errors);
        for (const user of [a, b]) await user.page.getByRole('button', { name: 'Video chat', exact: true }).click();
        await control(a.page, 'Start chat', 'start'); await control(b.page, 'Start chat', 'start');
        for (const user of [a, b]) await expectMediaFlow(user.page);
        await b.page.evaluate(() => {
            const pc = window.__driftMediaProbe.connections.at(-1);
            window.__restartAttempts = 0;
            pc.createOffer = async () => { window.__restartAttempts++; throw new Error('Injected ICE offer failure'); };
            Object.defineProperty(pc, 'connectionState', { configurable: true, value: 'failed' });
            pc.dispatchEvent(new Event('connectionstatechange'));
        });
        await expect(b.page.getByRole('button', { name: 'Reconnect video', exact: true })).toBeVisible({ timeout: 75000 });
        expect(await b.page.evaluate(() => window.__restartAttempts)).toBe(3);
        await b.page.waitForTimeout(1500);
        expect(await b.page.evaluate(() => window.__restartAttempts)).toBe(3);
        // Restore the native getter so the probe observes closure of this old PC.
        await b.page.evaluate(() => { delete window.__driftMediaProbe.connections.at(-1).connectionState; });
        await b.page.getByRole('button', { name: 'Reconnect video', exact: true }).click();
        for (const user of [a, b]) await expectMediaFlow(user.page);
        expect(await b.page.evaluate(() => window.__driftMediaProbe.streams.length)).toBe(1);
        expect(errors).toEqual([]);
    } finally { await cleanup(contexts); }
});
