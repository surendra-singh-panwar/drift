import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const responses = [];
    page.on('response', r => {
        if (r.url().endsWith('/chat/heartbeat') || r.url().endsWith('/broadcasting/auth')) {
            responses.push({ path: new URL(r.url()).pathname, status: r.status() });
        }
    });
    await page.goto('http://127.0.0.1:8000');
    await page.waitForTimeout(2000);
    await page.reload();
    await page.waitForTimeout(2000);
    console.log(JSON.stringify({ responses, conflict: await page.getByText('This session is active in another tab.', { exact: true }).count(), reconnecting: await page.getByText('Reconnecting…', { exact: true }).count() }));
} finally { await browser.close(); }
