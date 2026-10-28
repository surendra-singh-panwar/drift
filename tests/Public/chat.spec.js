import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('public HTTPS serves production assets, secure sessions and authorized WSS only', async ({ page, context, baseURL }) => {
    const errors = [];
    const requests = [];
    const sockets = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('request', request => requests.push(request.url()));
    page.on('websocket', socket => sockets.push(socket.url()));
    const auth = page.waitForResponse(r => r.url().endsWith('/broadcasting/auth'));
    const heartbeat = page.waitForResponse(r => r.url().endsWith('/chat/heartbeat'));
    const response = await page.goto('/');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
    expect((await auth).status()).toBe(200);
    expect((await heartbeat).status()).toBe(200);
    await expect(page.getByRole('button', { name: 'Start chat', exact: true })).toBeEnabled();
    const origin = new URL(baseURL).origin;
    expect(requests.every(url => new URL(url).origin === origin)).toBe(true);
    expect(requests.some(url => url.includes('/tunnel-build/assets/'))).toBe(true);
    expect(requests.some(url => /@vite|:5173|localhost|127\.0\.0\.1/.test(url))).toBe(false);
    expect(sockets.length).toBeGreaterThan(0);
    expect(sockets.every(url => url.startsWith(origin.replace('https:', 'wss:') + '/app/'))).toBe(true);
    const session = (await context.cookies()).find(cookie => cookie.name === 'drift_public_session');
    expect(session).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Lax', domain: new URL(baseURL).hostname });
    expect(errors).toEqual([]);

    // These intentional failures use the API client, not the page console.
    const noCsrf = await page.request.post('/chat/start', { data: { tab: randomUUID() } });
    expect(noCsrf.status()).toBe(419);
    const csrf = await page.locator('meta[name="csrf-token"]').getAttribute('content');
    const forbidden = await page.request.post('/broadcasting/auth', {
        data: { socket_id: '123.456', channel_name: `private-anonymous.${randomUUID()}` },
        headers: { 'X-CSRF-TOKEN': csrf, Accept: 'application/json' },
    });
    expect(forbidden.status()).toBe(403);
    for (const path of ['/.env', '/vendor/autoload.php', '/storage/logs/laravel.log', '/@vite/client', '/apps/123/events', '/_ignition/health-check', '/phpinfo.php']) {
        const denied = await page.request.get(path);
        expect(denied.status(), path).toBe(404);
        expect((await denied.text()).length).toBeLessThan(100);
    }
});

test('two independent visitors match and exchange live messages through public WSS', async ({ browser, baseURL }) => {
    const contexts = [];
    const errors = [];
    async function visitor() {
        const context = await browser.newContext({ baseURL });
        contexts.push(context);
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        await page.goto('/');
        await expect(page.getByRole('button', { name: 'Start chat', exact: true })).toBeEnabled();
        return page;
    }
    async function control(page, label, action) {
        const pending = page.waitForResponse(r => r.url().endsWith(`/chat/${action}`));
        await page.getByRole('button', { name: label, exact: true }).click();
        const response = await pending;
        expect(response.status()).toBe(200);
        return response.json();
    }
    try {
        const a = await visitor();
        const b = await visitor();
        const identity = page => page.locator('#app').evaluate(el => JSON.parse(el.getAttribute('data-page')).props.channel);
        expect(await identity(a)).not.toBe(await identity(b));
        expect((await control(a, 'Start chat', 'start')).status).toBe('searching');
        expect((await control(b, 'Start chat', 'start')).status).toBe('connected');
        for (const page of [a, b]) await expect(page.getByText('Connected with a stranger', { exact: true })).toBeVisible();
        for (const [from, to, text] of [[a, b, 'Hello through the public tunnel'], [b, a, 'Public WSS reply received']]) {
            await from.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
            await from.getByRole('button', { name: 'Send message', exact: true }).click();
            await expect(to.locator('.bubble', { hasText: text })).toHaveCount(1);
        }
        const heartbeat = a.waitForResponse(r => r.url().endsWith('/chat/heartbeat'));
        await a.reload();
        expect((await heartbeat).status()).toBe(200);
        await expect(a.getByText('Connected with a stranger', { exact: true })).toBeVisible();
        expect((await control(a, 'Next stranger', 'next')).status).toBe('searching');
        await expect(b.getByText('Stranger disconnected.', { exact: true })).toBeVisible();
        expect((await control(a, 'Stop', 'stop')).status).toBe('idle');
        await control(a, 'Start chat', 'start');
        await control(b, 'Start chat', 'start');
        await expect(a.getByText('Connected with a stranger', { exact: true })).toBeVisible();
        await control(a, 'Stop', 'stop');
        await expect(b.getByText('Stranger disconnected.', { exact: true })).toBeVisible();
        await expect(b.getByRole('textbox', { name: 'Message', exact: true })).toBeDisabled();
        await control(a, 'Start chat', 'start');
        await control(b, 'Start chat', 'start');
        await expect(a.getByText('Connected with a stranger', { exact: true })).toBeVisible();
        await a.close();
        await expect(b.getByText('Stranger disconnected.', { exact: true })).toBeVisible({ timeout: 75_000 });
        await expect(b.getByRole('textbox', { name: 'Message', exact: true })).toBeDisabled();
        expect(errors, 'Public browser console errors and uncaught exceptions').toEqual([]);
    } finally {
        await Promise.all(contexts.map(context => context.close()));
    }
});
