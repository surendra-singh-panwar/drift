import { defineConfig } from '@playwright/test';
import { readFileSync } from 'node:fs';

const url = process.env.DRIFT_PUBLIC_URL || JSON.parse(readFileSync('storage/app/tunnel/state.json', 'utf8').replace(/^\uFEFF/, '')).Url;
if (!url || !/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(url)) throw new Error('Start scripts/public-tunnel.ps1 or set DRIFT_PUBLIC_URL to the current HTTPS Quick Tunnel URL.');

export default defineConfig({
    testDir: './tests/Public',
    outputDir: './storage/framework/testing/public-browser',
    timeout: 240_000,
    expect: { timeout: 30_000 },
    workers: 1,
    reporter: 'list',
    use: { baseURL: url, channel: 'chrome', headless: true, trace: 'off', screenshot: 'only-on-failure' },
});
