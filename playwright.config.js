import { defineConfig } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export default defineConfig({
    testDir: './tests/Browser',
    outputDir: './storage/framework/testing/browser',
    timeout: 120_000,
    expect: { timeout: 15_000 },
    workers: 1,
    reporter: 'list',
    use: {
        baseURL: 'http://127.0.0.1:8001',
        channel: 'chrome',
        headless: true,
        // Do not retain session cookies, channel authorization, or message text in traces.
        trace: 'off',
        screenshot: 'only-on-failure',
    },
    webServer: {
        // Run PHP directly so Windows test teardown owns the actual listener,
        // rather than leaving artisan's child server behind.
        command: 'php -S 127.0.0.1:8001 ../vendor/laravel/framework/src/Illuminate/Foundation/resources/server.php',
        cwd: fileURLToPath(new URL('./public', import.meta.url)),
        url: 'http://127.0.0.1:8001',
        // Opt in only when deliberately reusing an already-running isolated test server.
        reuseExistingServer: process.env.DRIFT_REUSE_TEST_SERVER === 'true',
        timeout: 30_000,
        env: { CACHE_PREFIX: `drift-browser-${randomUUID()}:`, APP_URL: 'http://127.0.0.1:8001', DRIFT_BROWSER_TEST_BUILD: 'true' },
    },
});
