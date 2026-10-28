import { defineConfig } from 'vite';
import laravel from 'laravel-vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

export default defineConfig({
    build: {
        rollupOptions: {
            output: {
                manualChunks(id) {
                    if (/node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react-vendor';
                    if (/node_modules[\\/](pusher-js|laravel-echo)[\\/]/.test(id)) return 'realtime-vendor';
                },
            },
        },
    },
    plugins: [
        {
            name: 'drift-bundle-report',
            writeBundle(_, bundle) {
                if (!process.env.DRIFT_BUNDLE_REPORT) return;
                const chunks = Object.values(bundle).filter(item => item.type === 'chunk');
                const report = chunks.map(chunk => ({ file: chunk.fileName, entry: chunk.isEntry,
                    imports: chunk.imports, dynamicImports: chunk.dynamicImports,
                    bytes: Buffer.byteLength(chunk.code), gzipBytes: gzipSync(chunk.code).length,
                    modules: Object.entries(chunk.modules).map(([name, info]) => ({ name: name.replaceAll('\\', '/').split('/node_modules/').pop(), bytes: info.renderedLength })).sort((a, b) => b.bytes - a.bytes),
                }));
                writeFileSync(process.env.DRIFT_BUNDLE_REPORT, JSON.stringify(report, null, 2));
            },
        },
        laravel({
            buildDirectory: process.env.DRIFT_BUILD_DIRECTORY || 'build',
            input: ['resources/css/app.css', 'resources/js/app.jsx'],
            refresh: true,
        }),
        tailwindcss(), react(),
    ],
});
