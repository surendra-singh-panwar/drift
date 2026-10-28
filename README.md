# Drift - anonymous text and video chat

Laravel 12 / PHP 8.2+, Inertia 2 / React 19, Tailwind 4, Vite, Reverb, and file-backed or Redis (Predis) chat state. Random text chat, one-to-one video and native WebRTC mesh groups of up to eight people, without registration or stored chat history. See [video architecture, configuration and verification](docs/VIDEO-CHAT.md).

See [group video chat](docs/GROUP-VIDEO-CHAT.md) for matching, moderation, configuration and four-session testing.

See the [Oracle Cloud deployment guide](docs/deploy-oracle-cloud.md) for production readiness, cost limits, and Ubuntu deployment instructions.

## This machine

Ubuntu 26.04.1 LTS and Redis Server 8.0.5 are installed under WSL2. Windows Laravel connects through Predis at `127.0.0.1:6379`; both Redis connections and cache read/write/locks pass. All 17 PHP tests pass, including Redis concurrency (80 assertions), and all four Chrome tests pass. See [VERIFICATION.md](VERIFICATION.md) for current browser results and exact startup commands.

## Optional Redis

The single-host file store does not need Redis. If `CHAT_STORE=redis` or you are running the optional Redis concurrency test, keep this PowerShell terminal open because WSL can shut down after its last active Linux process exits:

```powershell
Set-Location 'D:\office work\project'
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-redis.ps1
```

The script starts the Ubuntu Redis service, prints PONG, and keeps Ubuntu running. Redis is restricted to loopback, protected mode is enabled, and persistence is disabled for temporary chat state.

## Run locally

From `D:\office work\project`, in separate PowerShell terminals:

```powershell
php artisan serve --host=127.0.0.1 --port=8000
```

```powershell
npm.cmd run dev
```

```powershell
php artisan reverb:start --host=127.0.0.1 --port=8080
```

Alternatively, `composer run dev` starts Laravel, Reverb and Vite together. Visit http://127.0.0.1:8000. Start Redis first only when `CHAT_STORE=redis`. No queue worker is required: broadcasts use ShouldBroadcastNow. Stop services with Ctrl+C. Windows PHP's development server is single-process; use a proper PHP web server for realistic concurrent HTTP load.

The generated `.env` already contains a fresh Laravel key and local Reverb secret; it is ignored by Git. Public Reverb app keys are not authentication credentials. Keep REVERB_APP_SECRET and APP_KEY private. Do not replace existing secrets when updating the application.

For a fresh checkout:

```powershell
composer install
npm.cmd ci
Copy-Item .env.example .env # Only if .env does not exist
php artisan key:generate
php -r "echo bin2hex(random_bytes(32)), PHP_EOL;"
```

Paste the generated value into REVERB_APP_SECRET in `.env`, then run `php artisan config:clear`. Rebuild or restart Vite after VITE_* changes. No migrations are required. To use MySQL for future reports/bans, set DB_CONNECTION=mysql and the DB_* values yourself; no chat table is needed.

## Verify

```powershell
npm.cmd run build
php artisan test
```

Tests cover waiting, matching, duplicate requests, recipient delivery and deduplication, membership checks, private-channel authorization, validation, Next/Stop, lease expiry, absolute expiry and duplicate tabs. Broadcasts are mocked and cache is in-memory in this suite; these tests do not prove live WebSocket delivery.

A separate real Redis concurrency test launches 24 PHP processes against twelve identities. It uses an isolated cache prefix and removes only its own state:

```powershell
$env:RUN_REDIS_TESTS = '1'
php artisan test --filter=RedisConcurrencyTest
Remove-Item Env:RUN_REDIS_TESTS
```

This test is skipped by default. It passed with Redis concurrency explicitly enabled during the latest verification; see VERIFICATION.md.

To check Redis through Laravel: `php tests/Support/check-services.php`. To run automated Chrome checks with Redis and Reverb running: `npm.cmd run test:browser`. The browser suite starts an isolated Laravel server on port 8001 and includes a natural heartbeat-expiry test. It uses the installed Chrome browser.

Manual end-to-end check: open a regular window and an incognito window (separate cookie sessions). Start A: searching. Start B: both connect. Send Hello and Hi in opposite directions. Next on A: B sees a disconnection and A searches. Stop A: welcome screen. Disconnect A's network: after the 45-second lease plus the next heartbeat (up to 10 seconds), B sees a disconnection. Reconnect recovers authoritative state through heartbeat; messages sent during a connection outage are not replayed.

## Behavior and security

- Server-generated anonymous UUIDs live in Laravel sessions; client identities are ignored. Private personal channels authorize strictly against that session. Participant IDs and room IDs are not bearer credentials. There is no public message channel.
- Redis cache locks serialize Start/Next/Stop/message validation across PHP workers. Waiting users are randomly selected; repeated Start is idempotent. One global snapshot and lock intentionally favor MVP correctness over throughput.
- Idle → searching → connected → idle. Next ends a room before searching again; Stop cancels both waiting and connected states. Only the two current members can send. Old rooms are immediately invalidated.
- Tab ownership survives refresh through sessionStorage. A browser Web Lock prevents duplicated tabs from reusing a copied owner token; the server continues to reject other live tab owners. A rejected tab automatically retries and recovers after the owner's 45-second lease expires (up to about 55 seconds with heartbeat timing). Refresh resumes the current room in Chrome. Browsers without Web Locks fall back to new tokens and lease-expiry recovery. Closing a tab relies on lease expiry, not unload handlers. Sleeping/background tabs may also expire.
- Heartbeats every 10 seconds renew activity. A one-hour absolute identity-state lifetime bounds deduplication metadata. Redis snapshot TTL is 3660 seconds; stale entries are pruned on the next request, including heartbeats from remaining users. There is no scheduled pruning process.
- CSRF on chat actions, session cookies, private authorization, 90 requests/minute/IP and session validation, max 2000-character trimmed messages, and React text rendering protect the basic flow. Shared NATs share the IP rate limit.
- Message text exists only in browser memory and the in-flight broadcast; the server retains only message UUID metadata until the room ends/expires. UUID deduplication covers the entire active room. Redis persistence should remain disabled for this data.
- Broadcast network I/O runs after the Redis lock is released; revisions prevent delayed state events overwriting newer state. Broadcast failure returns an error and is logged by Laravel; the transition may already be committed. Heartbeats repair state, but no durable outbox or message replay exists. Delivery is best effort, not guaranteed.
- No age verification, report/ban system or moderation service is included. Those are future work. Do not treat the MVP as production moderation infrastructure.

For production use HTTPS/WSS, SESSION_SECURE_COOKIE=true, APP_DEBUG=false, explicit REVERB_ALLOWED_ORIGINS, protected Redis, centralized sessions/cache for multiple app servers, supervised Reverb, shared key configuration and a web server that supports concurrent PHP requests. Scale beyond this MVP by replacing the global state snapshot/lock with partitioned atomic Redis operations. Keep future reports/bans persistent separately, and authorize future WebRTC signaling against the current room membership.
