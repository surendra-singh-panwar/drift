import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

test('homepage and authenticated private Reverb broadcast delivery', async ({ page }, testInfo) => {
    const errors = [];
    const exceptions = [];
    page.on('pageerror', error => exceptions.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const auth = page.waitForResponse(response => response.url().endsWith('/broadcasting/auth'));
    const heartbeat = page.waitForResponse(response => response.url().endsWith('/chat/heartbeat'));
    // Vite also opens a socket during development; observe the Reverb connection.
    const websocket = page.waitForEvent('websocket', socket => new URL(socket.url()).pathname.startsWith('/app/'));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Your next hello is waiting.' })).toBeVisible();
    expect((await auth).status()).toBe(200);
    await expect(page.getByText('Chat service connected', { exact: true })).toBeVisible();
    const status = (await heartbeat).status();
    expect(status).toBe(200);
    const socket = await websocket;
    const channel = await page.locator('#app').evaluate(el => JSON.parse(el.getAttribute('data-page')).props.channel);
    const nonce = randomUUID();
    const frame = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Private Reverb broadcast did not reach the browser')), 10_000);
        socket.on('framereceived', frame => {
            const event = JSON.parse(String(frame.payload));
            if (event.event === 'chat.updated' && JSON.parse(event.data).nonce === nonce) {
                clearTimeout(timer);
                resolve(event);
            }
        });
    });
    execFileSync('php', ['tests/Support/broadcast-probe.php', channel.replace('anonymous.', ''), nonce], { timeout: 10_000 });
    const event = await frame;
    expect(event.channel).toBe(`private-${channel}`);
    await testInfo.attach('browser-console-errors', { body: JSON.stringify(errors, null, 2), contentType: 'application/json' });
    await testInfo.attach('heartbeat-status', { body: String(status), contentType: 'text/plain' });
    // Redis health is checked separately by the full lifecycle test below.
    expect(exceptions, 'Browser must have no uncaught exceptions').toEqual([]);
    expect(errors, 'Healthy private delivery must have no browser console errors').toEqual([]);
});

test('two anonymous browsers: messages, Next, Stop and real heartbeat expiry', async ({ browser }, testInfo) => {
    const contexts = [];
    const errors = [];
    const pages = [];
    async function visitor() {
        const context = await browser.newContext({ baseURL: 'http://127.0.0.1:8001' });
        contexts.push(context);
        const page = await context.newPage();
        pages.push(page);
        page.on('pageerror', error => { errors.push(error.message); console.error('Chat browser exception:', error.message); });
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        const heartbeat = page.waitForResponse(response => response.url().endsWith('/chat/heartbeat'));
        await page.goto('http://127.0.0.1:8001');
        expect((await heartbeat).status(), 'Redis heartbeat prerequisite').toBe(200);
        await expect(page.getByRole('button', { name: 'Start chat', exact: true })).toBeEnabled();
        return { page, context };
    }
    async function control(page, label, action) {
        const response = page.waitForResponse(response => response.url().endsWith(`/chat/${action}`));
        await page.getByRole('button', { name: label, exact: true }).click();
        const result = await response;
        expect(result.status()).toBe(200);
        return { state: await result.json(), payload: result.request().postDataJSON() };
    }
    async function api(page, action, body) {
        const csrf = await page.locator('meta[name="csrf-token"]').getAttribute('content');
        return page.request.post(`/chat/${action}`, { data: body, headers: { 'X-CSRF-TOKEN': csrf, Accept: 'application/json' } });
    }
    try {
        const a = await visitor();
        const b = await visitor();
        const identity = page => page.locator('#app').evaluate(el => JSON.parse(el.getAttribute('data-page')).props.channel);
        expect(await identity(a.page)).not.toBe(await identity(b.page));
        const startA = await control(a.page, 'Start chat', 'start');
        expect(startA.state.status).toBe('searching');
        await expect(a.page.getByText('Looking for someone to chat with...')).toBeVisible();
        const startB = await control(b.page, 'Start chat', 'start');
        expect(startB.state.status).toBe('connected');
        console.log('Both Start requests completed; checking live matched state.');
        const room = startB.state.room;
        for (const page of [a.page, b.page]) await expect(page.getByText('Connected with a stranger', { exact: true })).toBeVisible();

        const resumed = a.page.waitForResponse(response => response.url().endsWith('/chat/heartbeat'));
        await a.page.reload();
        const recovered = await resumed;
        expect(recovered.status()).toBe(200);
        expect((await recovered.json()).room).toBe(room);
        await expect(a.page.getByText('Connected with a stranger', { exact: true })).toBeVisible();
        await expect(a.page.getByText('Chat service connected', { exact: true })).toBeVisible();

        await a.page.getByRole('textbox', { name: 'Message', exact: true }).fill('Hello');
        await a.page.getByRole('button', { name: 'Send message', exact: true }).click();
        await expect(b.page.locator('.bubble', { hasText: /^Hello$/ })).toHaveCount(1);
        await b.page.getByRole('textbox', { name: 'Message', exact: true }).fill('Hi');
        await b.page.getByRole('button', { name: 'Send message', exact: true }).click();
        await expect(a.page.locator('.bubble', { hasText: /^Hi$/ })).toHaveCount(1);

        const duplicate = { tab: startA.payload.tab, room, id: randomUUID(), text: '<script>window.driftXss=true</script>' };
        expect((await api(a.page, 'message', duplicate)).status()).toBe(200);
        expect((await api(a.page, 'message', duplicate)).status()).toBe(200);
        await expect(b.page.locator('.bubble', { hasText: duplicate.text })).toHaveCount(1);
        expect(await b.page.evaluate(() => window.driftXss)).toBeUndefined();

        const next = await control(a.page, 'Next stranger', 'next');
        expect(next.state.status).toBe('searching');
        await expect(b.page.getByText('Stranger disconnected.', { exact: true })).toBeVisible();
        expect((await api(a.page, 'message', { ...duplicate, id: randomUUID() })).status()).toBe(403);
        expect((await control(a.page, 'Stop', 'stop')).state.status).toBe('idle');
        await expect(a.page.getByRole('heading', { name: 'Your next hello is waiting.' })).toBeVisible();

        // Stop while connected must also notify the peer and disable its composer.
        await control(a.page, 'Start chat', 'start');
        await control(b.page, 'Start chat', 'start');
        await expect(a.page.getByText('Connected with a stranger', { exact: true })).toBeVisible();
        await control(a.page, 'Stop', 'stop');
        await expect(b.page.getByText('Stranger disconnected.', { exact: true })).toBeVisible();
        await expect(b.page.getByRole('textbox', { name: 'Message', exact: true })).toBeDisabled();

        // Close a real browser context: only the peer's natural 10-second heartbeat prunes the 45-second lease.
        await control(a.page, 'Start chat', 'start');
        await control(b.page, 'Start chat', 'start');
        await expect(a.page.getByText('Connected with a stranger', { exact: true })).toBeVisible();
        await test.step('Close the active chat tab', () => a.page.close());
        await expect(b.page.getByText('Stranger disconnected.', { exact: true })).toBeVisible({ timeout: 65_000 });
        await expect(b.page.getByRole('textbox', { name: 'Message', exact: true })).toBeDisabled();
        expect(errors, 'Browser console errors and uncaught exceptions').toEqual([]);
    } finally {
        // Best-effort Stop only for these browsers; never flush shared Redis state.
        for (const page of pages) {
            if (!page.isClosed()) {
                const stop = page.getByRole('button', { name: 'Stop', exact: true });
                if (await stop.isEnabled().catch(() => false)) await stop.click().catch(() => {});
            }
        }
        await testInfo.attach('browser-console-errors', { body: JSON.stringify(errors, null, 2), contentType: 'application/json' });
        await test.step('Close browser contexts', async () => {
            await Promise.all(contexts.map(context => context.close()));
        });
    }
});

test('copied tab owner is rejected, then automatically recovers after the owner closes', async ({ context, page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Start chat', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Start chat', exact: true }).click();
    await expect(page.getByText('Looking for someone to chat with...')).toBeVisible();
    const saved = await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage).filter(([key]) => key.startsWith('drift:tab:'))));
    const duplicate = await context.newPage();
    // Browsers may clone sessionStorage when duplicating a tab or opening via window.opener.
    await duplicate.addInitScript(values => {
        for (const [key, value] of Object.entries(values)) sessionStorage.setItem(key, value);
    }, saved);
    const blocked = duplicate.waitForResponse(response => response.url().endsWith('/chat/heartbeat'));
    await duplicate.goto('/');
    expect((await blocked).status()).toBe(409);
    await expect(duplicate.getByText('Chat active in another tab', { exact: true })).toBeVisible();
    await expect(duplicate.getByRole('button', { name: 'Start chat', exact: true })).toBeDisabled();
    await expect(page.getByText('Looking for someone to chat with...')).toBeVisible();
    await page.close();
    await expect(duplicate.getByRole('button', { name: 'Start chat', exact: true })).toBeEnabled({ timeout: 65_000 });
    await expect(duplicate.getByText('This session is active in another tab.', { exact: true })).toHaveCount(0);
    await expect(duplicate.getByText('Chat service connected', { exact: true })).toBeVisible();
    await duplicate.getByRole('button', { name: 'Start chat', exact: true }).click();
    await expect(duplicate.getByText('Looking for someone to chat with...')).toBeVisible();
    await duplicate.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(duplicate.getByRole('button', { name: 'Start chat', exact: true })).toBeEnabled();
});

test('WebSocket subscription recovers after a real network interruption', async ({ context, page }) => {
    const exceptions = [];
    page.on('pageerror', error => { exceptions.push(error.message); console.error(error.stack); });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Start chat', exact: true })).toBeEnabled();
    await context.setOffline(true);
    await expect(page.getByRole('button', { name: 'Start chat', exact: true })).toBeDisabled();
    await expect(page.getByText('Reconnecting…', { exact: true })).toBeVisible();
    const authorization = page.waitForResponse(response => response.url().endsWith('/broadcasting/auth'));
    const heartbeat = page.waitForResponse(response => response.url().endsWith('/chat/heartbeat'));
    await context.setOffline(false);
    expect((await authorization).status()).toBe(200);
    expect((await heartbeat).status()).toBe(200);
    await expect(page.getByRole('button', { name: 'Start chat', exact: true })).toBeEnabled({ timeout: 40_000 });
    await expect(page.getByText('Chat service connected', { exact: true })).toBeVisible();
    expect(exceptions).toEqual([]);
});
