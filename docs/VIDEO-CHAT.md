# Random video chat

> Current configuration, recovery, mesh-quality and testing guidance: [WebRTC operations](webrtc-deployment.md). Group capacity is now eight; local file storage does not require Redis. Historical implementation notes below may describe the earlier behavior.

## Analysis and architecture

The project already contained native WebRTC video support and video tests. This work extends that implementation. Installed technologies are Laravel 12, PHP 8.2.12, Inertia 2, React 19, Tailwind 4, Vite 6, Echo/Pusher, Laravel Reverb, and Predis. No new dependencies or migrations are needed. The User model is unused for anonymous chat; there are no media models or recording tables.

AnonymousSession creates the server-owned identity in the Laravel session. tab-session.js persists a tab UUID and uses Web Locks to prevent duplicated tabs from claiming the same token. Private-channel authorization compares the session identity with the requested channel. ChatController validates input; MatchmakingService owns all transitions. ChatUpdated broadcasts immediately to the recipient's private Reverb channel after releasing the Redis lock. No queue worker is required.

One Redis snapshot contains users and rooms. A single transition lock serializes matching, membership validation, and termination. Start randomly selects another waiting user in the same mode. Text and video queues are separated by a mode filter. Each identity can own only one room. Next ends the old room before searching again; Stop ends either the room or waiting state. Heartbeats run every ten seconds; a 45-second lease and one-hour absolute lifetime prune abandoned users on subsequent requests. Snapshot TTL bounds abandoned state when no users return. The global lock favors MVP correctness over throughput.

## WebRTC signaling and lifecycle

use-video-call.js acquires camera and microphone after a user gesture. VideoPanel.jsx displays inline local and remote streams, with local playback muted. Blocked autoplay exposes a Play video and audio button. Permission denial, missing/busy devices, and ended device tracks produce errors.

SDP is exempted from Laravel string trimming so its required trailing CRLF reaches the peer unchanged. Validated ready/offer/answer/ICE requests go through authenticated, CSRF-protected HTTP `/chat/signal`, then existing private Reverb channels. The server chooses the recipient from active room membership. SDP and ICE are never stored in Redis. Payload sizes and per-session/IP rates are bounded. Match and ended events establish/terminate the session; actual media connection status comes from RTCPeerConnection.

The second matched arrival is the sole offer initiator, avoiding simultaneous offer collisions. Each browser connection gets an instance UUID and each offer gets a negotiation UUID. Outgoing signaling and incoming negotiation operations are serialized. Candidates arriving before remote descriptions are buffered. Repeated readiness announcements recover lost initial messages; refreshed/reconnected peers announce new instances. Failed connections expose a reconnect button.

Monotonic signaling sequence numbers reject replayed requests. Redis stores only hashed instance IDs and last counters; retired instances cannot resume. Metadata is bounded to 128 instances per participant per room. Old rooms are rejected after Next/Stop; browsers filter rooms, peer instances and negotiation IDs. Reload clients after deploying this protocol change.

Next immediately closes the old peer and invalidates queued signaling before awaiting the server, while keeping local tracks alive. Stop closes media immediately, cancels pending camera results, waits for in-flight chat actions, and retries cleanup on recovery after an outage. Late permission results are stopped. A synchronous guard prevents repeated controls from creating competing calls. Device loss ends the session. Pagehide and unmount release tracks; remote termination also releases local media.

Refresh preserves the room and tab owner; click Enable camera and microphone to resume media. Socket recovery uses private resubscription and authoritative heartbeats before renegotiating. Abrupt tab/process loss uses the existing lease expiry. Existing text messaging remains available inside video calls.

The native lifecycle follows the [WebRTC specification](https://www.w3.org/TR/webrtc/). Media travels directly between browsers or through TURN; Reverb carries signaling only. Drift does not record streams. Participants can still record their own browser output.

## Modified and new files

Modified: app/Http/Controllers/ChatController.php, app/Services/MatchmakingService.php, resources/js/app.jsx, resources/js/use-video-call.js, resources/css/app.css, tests/Feature/VideoChatTest.php, tests/Browser/video.spec.js, app/Providers/AppServiceProvider.php, config/app.php, playwright.config.js, bootstrap/app.php, .env.example, README.md. Frontend build artifacts are regenerated. New: this document. Existing VideoPanel.jsx, config/webrtc.php, routes and video styling are reused.

## Test locally

Reuse running services. Otherwise, from `D:\office work\project`, start these in separate PowerShell terminals and keep both open:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-redis.ps1
```

```powershell
composer run dev
```

1. Open http://127.0.0.1:8000 in normal Chrome and an Incognito window, giving separate cookie sessions.
2. Select Video chat in both windows, click Start chat, and allow camera/microphone. Some physical devices cannot be shared between browser sessions; test on two devices over HTTPS if necessary.
3. Check remote video and audible speech in both directions, microphone mute, camera toggles, and text messaging. Use headphones to avoid feedback.
4. Click Next: old video disappears immediately, the other visitor disconnects, and your local preview remains. Start the other visitor again or introduce a third independent visitor.
5. Click Stop while waiting and connected; confirm the browser camera indicator turns off. Start again.
6. Refresh, enable media again, and test offline/online recovery, tab close, denied permissions and device removal. Abandoned peers expire in approximately 45–55 seconds while the remaining browser heartbeats.
7. Two tabs sharing cookies intentionally cannot own simultaneous chats. Additional strangers need independent browser profiles.

Automated checks, with Redis and Reverb running:

```powershell
$env:RUN_REDIS_TESTS = '1'
php artisan test
Remove-Item Env:RUN_REDIS_TESTS
npm.cmd run build
npm.cmd run test:browser
```

Chrome tests use simulated camera/microphone input with real peer connections, RTP statistics and decoded video frames. They check media cleanup, text messaging, Next/Stop, refresh, networking, queue separation, permissions and device loss. Redis concurrency tests use isolated keys. Browser tests create an isolated HTTP server on port 8001 with a unique cache prefix. No shared Redis flush is used. The test server sets DRIFT_BROWSER_TEST_BUILD=true to use built assets independently of the development Vite server. Run the build before browser tests.

## Production TURN configuration

Add the following to the existing .env without replacing Laravel/Reverb credentials:

```dotenv
STUN_URLS=stun:stun.l.google.com:19302
TURN_URLS=turn:relay.example.com:3478?transport=udp,turns:relay.example.com:5349?transport=tcp
TURN_SECRET=your-server-side-shared-secret
TURN_TTL=7200
WEBRTC_ICE_TRANSPORT_POLICY=all
```

Provision a TURN service such as coturn with matching REST shared-secret authentication, realm, valid TLS certificates for turns, a reachable advertised public address, and listening/relay ports allowed by its firewall. Laravel issues short-lived HMAC credentials; the shared secret remains on the server. TURN_USERNAME/TURN_PASSWORD are an alternative and necessarily visible to clients; use restricted credentials. Never prefix TURN_SECRET with VITE_. Run `php artisan config:clear` and reload the page after changing configuration.

STUN-only local development requires no paid service but cannot connect all NAT/firewall combinations. To validate TURN, use WEBRTC_ICE_TRANSPORT_POLICY=relay on separate networks and inspect the selected relay candidates. Direct peer connections can reveal network addresses; relay-only mode is required to hide those addresses from peers. Outside localhost, HTTPS/WSS is required, including mobile LAN access. No TURN server or credentials were provisioned here.

Remaining manual checks: physical cameras/microphones and listening quality, Chrome/Incognito with real devices, Safari/mobile, and cross-network TURN/firewall behavior. Same-machine simulated tests do not verify those. Long-lived pages need reloading for fresh TURN credentials. Signaling is best effort, with readiness/heartbeat recovery rather than a durable outbox. Moderation/reporting and replacement of the global Redis lock for greater scale remain production work.

## Verification performed on 2026-10-26

- Laravel suite with RUN_REDIS_TESTS=1: 26 passed, 129 assertions, including real concurrent Redis workers, signaling roles/membership, stale rooms, replay rejection, and exact SDP preservation through HTTP middleware.
- Frontend production build passed. Vite reports the existing main-bundle size advisory (approximately 555 kB before gzip).
- Four Chrome text browser cases passed: private Reverb delivery, text lifecycle/expiry, duplicate-tab recovery, and offline/online subscription recovery.
- Five Chrome video browser cases passed: two-way inbound audio RTP and decoded video frames, text during calls, mute/camera controls, refresh, network recovery, immediate peer closure on Next, Stop and peer-close cleanup, mode separation, genuine permission denial, pending permission cancellation, in-flight Start/Stop ordering, and simulated device-ended cleanup.
- A further video queue/media run passed after the final layout build, including the assertion that remote video is larger than the local preview.
- Redis PING and Laravel cache read/write/locks passed. Application Redis was not flushed; .env credentials were preserved. Existing Redis/Reverb/development services were reused.
- Healthy media paths had no uncaught browser exceptions. Deliberate offline errors and HTTP 403 stale-signal rejections during room termination are treated as expected; other console errors still fail tests. Laravel log errors observed during verification are from the deliberately injected Redis outage test.

Physical camera/microphone, listening quality, cross-network TURN, and mobile/Safari verification were not performed.
Browser test assertions completed successfully, but the Windows runner stalled during final process teardown and was stopped with Ctrl+C. The isolated test server was stopped; existing development services were retained.
