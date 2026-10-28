# Drift local verification — 2026-10-26

Ubuntu 26.04.1 LTS was installed with user approval under WSL2. Linux execution was verified with kernel `6.18.33.2-microsoft-standard-WSL2`. Redis Server 8.0.5 is installed and responds with PONG inside Ubuntu and through Laravel Predis on Windows at `127.0.0.1:6379`.

Redis binds to `127.0.0.1` and `::1`, with protected mode enabled. Snapshot saves and append-only persistence are disabled for temporary chat state. Existing application code and credentials were preserved.

## Checks

- `php artisan config:clear`: passed.
- `php tests/Support/check-services.php`: default/cache PONG and cache read/write/lock passed.
- `RUN_REDIS_TESTS=1 php artisan test`: 17 passed, 80 assertions. Includes 24 concurrent PHP processes for twelve identities, producing six unique rooms, plus owner resume and lease-expiry regression coverage.
- `npm.cmd run build`: passed; bundle-size advisory (542.85 kB main JavaScript before gzip).
- `composer run dev`: started Laravel on 8000, Reverb on 8080, Vite on 5173. Homepage returned HTTP 200.
- `npm.cmd run test:browser`: 4 passed (1.8 minutes) in real Chrome. Verified authenticated private Reverb delivery, distinct identities in independent browser contexts, random matchmaking, bidirectional messages, deduplication, safe text rendering, Next, stale-room rejection, Stop, natural heartbeat expiry after tab close, refresh of a connected room, copied-tab rejection and automatic recovery, and real offline/online recovery with fresh authorization and heartbeat HTTP 200. Healthy delivery/lifecycle runs had no browser console errors or uncaught exceptions. Expected HTTP 409 responses are verified in the duplicate-tab test; the offline test verifies recovery without uncaught exceptions.
- `node tests/Support/probe-refresh.mjs`: on port 8000, authorization and heartbeat returned 200 before and after refresh; no session-conflict or reconnecting label remained.
- `php tests/Support/inspect-chat-state.php`: read-only aggregate inspection showed no stale users and no transition lock (`TTL -2`). No Redis cleanup was needed or performed. Laravel sessions use files; tab leases live inside the Redis `chat:state` snapshot, not individual persistent session-lock keys.

## Run locally

In PowerShell terminal 1 (keep open to prevent WSL idle shutdown):

```powershell
Set-Location 'D:\office work\project'
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-redis.ps1
```

This starts the Redis service as the Ubuntu root user and keeps a Linux process alive. No Linux password was created or needed for this service setup. Redis persistence remains disabled. Ctrl+C ends the keepalive; WSL can subsequently shut down.

In PowerShell terminal 2:

```powershell
Set-Location 'D:\office work\project'
php artisan config:clear
php tests/Support/check-services.php
composer run dev
```

Visit http://127.0.0.1:8000. Stop development servers with Ctrl+C. No database migration or queue worker is required. The Windows PHP development server uses a single worker.

In another terminal, with Redis and development services running:

```powershell
Set-Location 'D:\office work\project'
$env:RUN_REDIS_TESTS = '1'
php artisan test
Remove-Item Env:RUN_REDIS_TESTS
npm.cmd run test:browser
```

Browser tests use Chrome, an isolated Laravel server on port 8001, unique Redis cache prefixes, and Reverb on 8080. They do not flush shared Redis state. Keep ports 8000, 8080 and 5173 free before starting development servers; avoid starting a second copy while one is already running.

## Fixes discovered during live verification

- React scrolling effect now uses a block body so its browser API result cannot become a React cleanup value. Previously matching crashed the view with `destroy is not a function` in the installed Chrome. The full live browser suite passes with this fix.
- Browser probes explicitly select Reverb `/app/` sockets rather than Vite HMR. The final suite uses real sockets throughout, including Vite. The previous HMR WebSocket interception was removed because it produced an artificial socket-close exception during offline testing.
- Browser disconnection uses a real tab close, and browser contexts are cleaned up together.
- Added `scripts/start-redis.ps1` because Ubuntu stopped after its last active Linux shell exited, dropping Redis despite an earlier successful PONG. Keeping the script terminal open preserves service availability.

Laravel, Reverb, Vite and the Ubuntu keepalive were left running after verification. Avoid launching duplicate development servers. Credentials and `.env` were not changed. No manual browser verification was performed.

## Refresh and reconnection root causes and fixes

Originally each page load generated a new tab UUID while the Laravel anonymous session stayed the same. A reload therefore conflicted with its own live 45-second Redis lease. Chrome reproduced authorization HTTP 200 followed by heartbeat HTTP 409 after reload. The frontend also set `ready=false` on that conflict but never restored it after successful periodic heartbeats; it misleadingly displayed “Reconnecting” for an ownership conflict. A real offline/online test additionally found that a short outage could leave the subscription unready without a fresh subscription callback.

The tab owner now persists in sessionStorage across refresh, with a browser Web Lock preventing simultaneously open documents from reusing a cloned token. A duplicated tab receives its own token and the unchanged server-side lease check rejects it. After the old owner closes, a rejected tab keeps retrying and becomes ready after lease expiry (typically within 55 seconds). Refresh resumes the same room immediately in tested Chrome. Older already-open pages may require one reload and an initial lease-expiry wait to adopt the new token scheme.

Connection status and ownership conflicts are displayed separately. Successful authoritative heartbeats restore readiness only with an active private subscription. Offline/online events explicitly disconnect/reconnect Pusher, followed by fresh authorization and heartbeat checks. Reverb was already running on 8080 and its configured endpoint and authorization worked; credentials and Vite environment settings did not require changes.

Independent Chrome contexts have separate cookie jars and produced different anonymous identities. This verifies the session isolation used by normal Chrome versus Incognito without accessing the user's existing browser profile. Two tabs within the same Incognito session still share cookies and are intentionally subject to single-tab protection. Messages are not replayed after refresh; chat history remains in browser memory only.
