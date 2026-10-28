# WebRTC reliability and performance work

The existing Laravel/Reverb/WebRTC mesh architecture and eight-person matchmaking limit are retained. No database migrations, Redis requirement, SFU, new application server or external TURN subscription were introduced. The existing `.env`, database, normal local cache directory, themes and video viewing controls were preserved.

## Changes

- Added authenticated, CSRF-protected `POST /chat/ice`. It requires the current anonymous session, active room, owning tab, live heartbeat lease, unexpired session lifetime and current group membership generation. Its own per-session/IP limiter avoids competing with normal chat action limits. Responses cannot be cached. The homepage no longer delivers TURN passwords.
- Reused the existing environment-driven STUN/TURN settings. The server signs temporary coturn REST credentials; the shared secret stays on Laravel. Active clients can refresh credentials without rebuilding the application. Static credential providers remain compatible, with the exposure limitation documented.
- Added per-edge recovery on both connection and ICE events, plus browser online/offline handling. A four-second disconnection grace period is followed by bounded 1/3/7-second backoffs, with a 15-second outcome window. Only the assigned offerer starts ICE negotiation, using the same peer connection. The answerer can request a restart. Stable connections reset their retry budget after 30 seconds.
- Preserved healthy RTP during brief signaling outages. Stop, Next, membership changes, unmount and lease expiry cancel/invalidate the appropriate work. No recovery path chooses a new stranger automatically. A backend lease that expires cannot be resurrected by WebRTC recovery.
- Added generation checks for stale SDP/ICE and serialized offer creation. Existing server instance/sequence/epoch defenses remain intact. Camera switching, digital zoom, fit/fill, expand and fullscreen are preserved.
- Lazy-loaded the media runtime, WebRTC hook, one-to-one panel and group panel. Text-only browser sessions do not request these modules. Split React and real-time libraries into independently cacheable vendor chunks; dependencies remain deduplicated.
- Group capture starts at 640×360/20 fps instead of every participant requesting HD. One capture stream is shared across edges. Per-edge encoding budgets divide a default 1.8 Mbps video upload target among peers. Loss, RTT, available bitrate and constrained-device hints reduce video quality while leaving audio enabled. Eight-second stats sampling and slower upward quality changes limit overhead and oscillation. Group peers skip unrelated parent renders.
- Browser tests use a separate file-cache directory, since FileStore does not support key prefixes. The test server runs PHP directly so Windows teardown owns the listener instead of leaving an artisan child server behind. Existing Reverb is reused.

## JavaScript delivery

Measured minified JavaScript on this checkout, decimal KB, excluding CSS and HTTP headers:

| Metric | Before | After |
| --- | ---: | ---: |
| Largest chunk | 566.38 KB | 231.16 KB |
| Initial text-chat JS, all required chunks | 566.38 KB | 548.54 KB |
| Initial text-chat JS, gzip | 178.02 KB | 173.66 KB |
| Deferred video code, all video modes | bundled initially | 24.37 KB |
| All application JS, including video | 566.38 KB | 572.91 KB |

The largest chunk is about 59% smaller. Initial text JS transfer is about 3.1% smaller uncompressed and 2.4% smaller gzipped. The initial saving is modest: React, Inertia, Axios and Reverb client code remain necessary for text chat. Total code grew about 6.53 KB as recovery and adaptation were added. Splitting does not make required dependencies disappear; it improves caching and defers video code. The chunk warning threshold was not increased, and the final build has no oversized-chunk warning.

Before-build module analysis identified React DOM, Pusher, Inertia Core/React and Axios among the largest dependencies. The optimized build has a 223.86 KB React vendor chunk, a 93.53 KB real-time vendor chunk and a 231.16 KB application/navigation chunk. `npm ls react react-dom --all` confirms one deduplicated React/React DOM installation.

For a future comparison, in PowerShell:

```powershell
$env:DRIFT_BUNDLE_REPORT='storage/app/bundle-after.json'
npm run build
Remove-Item Env:DRIFT_BUNDLE_REPORT
```

The optional report lists each final chunk's byte/gzip size, imports and contributing modules. This task's baseline and optimized reports are retained in `storage/app/bundle-before.json` and `storage/app/bundle-after.json`.

## Files

Application and configuration:

- `app/Http/Controllers/ChatController.php`
- `app/Http/Controllers/IceConfigurationController.php` (new)
- `app/Services/IceConfiguration.php` (new)
- `app/Providers/AppServiceProvider.php`
- `routes/web.php`
- `config/cache.php`
- `resources/js/app.jsx`
- `resources/js/use-video-call.js`
- `resources/js/use-video-controller.jsx` (new)
- `resources/js/VideoRuntime.jsx` (new)
- `resources/js/video-quality.js` (new)
- `resources/js/GroupVideoPanel.jsx`
- `vite.config.js`
- `package.json`
- Regenerated `public/build` artifacts.

Tests and documentation:

- `playwright.config.js`
- `tests/Feature/VideoChatTest.php`
- `tests/Feature/IceConfigurationTest.php` (new)
- `tests/Feature/GroupChatTest.php`
- `tests/Browser/video.spec.js`
- `tests/Browser/group.spec.js`
- `tests/Frontend/video-quality.test.js` (new)
- `docs/webrtc-deployment.md` (new)
- `docs/VIDEO-CHAT.md` and `docs/GROUP-VIDEO-CHAT.md` (links to current guidance)
- This report.

## Validation

- Laravel suite: 41 passed, 3 optional integration tests skipped, 198 assertions.
- Frontend quality-policy tests: 3 passed.
- Production build: passed; largest JS chunk remains below the default warning threshold.
- Browser suite: final results recorded after the complete run below.

The browser suite uses synthetic capture devices but real Chrome peer connections, SDP, ICE, DTLS, RTP and decoded frames. It checks text chat, group media, individual calls, room ownership, permission denial, pending capture cleanup, device removal, refresh, real browser offline/online events, lease cleanup, delayed signals, same-peer ICE restarts, retry exhaustion, Next/Stop cancellation and lazy loading. Its synthetic state failures exercise recovery scheduling; browser offline simulation is not a substitute for physically changing mobile networks.

## Deployment and remaining checks

See [WebRTC deployment and manual testing](webrtc-deployment.md) for environment variables, coturn configuration, firewall/TLS setup, security considerations, relay-only verification and the real-device checklist. Those instructions follow the linked upstream coturn/WebRTC references.

No public TURN host was provisioned or tested, and no TURN secret was invented or placed in the frontend. Production still requires a reachable relay, DNS, certificates, firewall/relay ports, secret distribution, synchronized clocks, bandwidth provisioning and monitoring. Temporary credentials are still visible to their authorized browser and remain usable until expiration even after leaving a room.

Physical front/back cameras, iOS/Android behavior, restrictive NAT/firewalls, real packet loss and eight physical devices have not been tested here. Automated mesh media checks cover smaller local groups; backend capacity and fan-out checks cover eight participants. Seven outgoing edges per device remain a mesh scalability constraint. Browser support for sender parameters varies; unsupported adaptation falls back to native congestion control. Existing file-backed matchmaking remains a single-host design with a global transition lock.
