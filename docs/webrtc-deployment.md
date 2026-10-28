# Drift WebRTC operations

Drift still uses Reverb for authenticated signaling and WebRTC mesh for media, with a maximum of eight participants. No Redis or SFU is required by these changes. File chat state is suitable for one application host with a shared writable cache directory; independent application hosts must not maintain separate matchmaking snapshots.

## ICE configuration and authorization

The homepage exposes STUN URLs and a TURN availability flag, not TURN passwords. After joining a video room the client requests `POST /chat/ice` with the current tab UUID, room UUID and, for groups, membership UUID. Laravel checks the anonymous session identity, tab ownership, room membership, video mode, heartbeat lease and absolute session lifetime under the matchmaking lock. The CSRF-protected, rate-limited response is marked `no-store, private`. An anonymous visitor who has not joined an active video room cannot retrieve credentials.

`TURN_SECRET` remains on Laravel and coturn. Laravel generates coturn REST credentials using an expiring timestamp and random identifier, signed with HMAC-SHA1. Browsers necessarily receive their temporary TURN credentials. They never receive the shared signing secret. Static `TURN_USERNAME` / `TURN_PASSWORD` remain compatible for providers that require them, but those passwords are visible to active clients; use REST credentials for production.

Configuration is shared by individual and group calls. Mesh edges reuse one in-flight configuration request per browser/room/membership. Credentials are refreshed shortly before expiry and on ICE recovery; each request rechecks current server authorization. Configuration from a room that has ended or changed membership is rejected by the client. The application cannot invalidate already-issued TURN credentials before their timestamp expires.

Multiple STUN and TURN endpoints are comma-separated in `STUN_URLS` and `TURN_URLS`. TURN endpoints may specify `?transport=udp` or `?transport=tcp`; use `turns:` for TLS (with TCP transport). ICE URL syntax and transport values are validated before they are sent to browsers. A TURN endpoint without valid credentials remains unused; Drift does not invent or embed provider credentials.

## Production coturn setup

Provision a Linux relay host with a public IP, DNS such as `turn.example.com`, a TLS certificate for that name, and adequate outbound bandwidth. Install coturn through the host's package manager and configure its service. Generate a long random secret on the host (for example `openssl rand -hex 32`), and store the same value in coturn and Laravel's secret environment. Never put it in a `VITE_` variable, JavaScript, source control or frontend error reports.

Example `/etc/turnserver.conf` (replace every placeholder):

```ini
listening-port=3478
tls-listening-port=5349
fingerprint
use-auth-secret
static-auth-secret=REPLACE_WITH_RANDOM_SHARED_SECRET
realm=turn.example.com
server-name=turn.example.com
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
min-port=49160
max-port=49260
no-cli
no-multicast-peers
no-tlsv1
no-tlsv1_1
user-quota=16
total-quota=1000
```

Those quotas are starting examples, not capacity guarantees. Give only the coturn service access to the secret and private key. Add `external-ip=PUBLIC_IP/PRIVATE_IP` when the relay is behind one-to-one NAT. Configure `listening-ip` and `relay-ip` for the host's actual interfaces where necessary. Block relay access to private/internal networks, loopback and cloud metadata addresses using appropriate coturn peer deny rules and host/network firewall rules. Do not enable unauthenticated TURN. Verify syntax against the installed coturn version. Certificate renewal must also reload/restart the service as appropriate.

Open inbound UDP and TCP 3478, TCP 5349, and the configured UDP relay port range through host and cloud firewalls. Allow outgoing media traffic. TURN over TLS on TCP 443 can help restrictive networks, but requires a dedicated IP/port or a suitable layer-4 TLS routing setup; a normal HTTP reverse proxy cannot proxy TURN. If using port 443, change both coturn's TLS listener and the URL below. Do not bind it over an existing web server's listener.

Laravel environment:

```dotenv
STUN_URLS=stun:turn.example.com:3478
TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp
TURN_SECRET=REPLACE_WITH_THE_SAME_SHARED_SECRET
TURN_TTL=1800
TURN_USERNAME=
TURN_PASSWORD=
WEBRTC_ICE_TRANSPORT_POLICY=all
```

Run `php artisan config:cache` during deployment and restart persistent application processes. Serve the app and Reverb over HTTPS/WSS and synchronize Laravel/coturn clocks. `TURN_TTL` is bounded to 300–86400 seconds by application configuration. Production deployments still require relay provisioning, DNS, TLS, firewall configuration, secret distribution, quotas, monitoring and a cross-network relay test. This task does not provision or validate an external TURN server.

Keep `TURN_URLS` and TURN credentials empty for existing STUN-only local behavior. To verify the production relay, temporarily set `WEBRTC_ICE_TRANSPORT_POLICY=relay`, refresh configuration, join from two different networks, and inspect the selected candidate pair in browser WebRTC diagnostics for a `relay` candidate. Restore `all` after the test unless relay-only privacy is a deliberate product requirement. TURN addresses and relay failures must be verified with the actual deployed service; localhost success does not establish public-network reliability.

## Recovery

Each edge watches both connection and ICE states. A disconnected edge shows an interrupted status during its grace period, then enters bounded recovery. Defaults are a four-second grace period, a 30-second initial connection timeout (60 seconds for batched group ICE), three attempts with 1/3/7-second backoffs and a 15-second outcome window per attempt. These values can be adjusted with `WEBRTC_DISCONNECT_GRACE_MS`, `WEBRTC_CONNECT_TIMEOUT_MS`, `WEBRTC_GROUP_CONNECT_TIMEOUT_MS`, `WEBRTC_RECOVERY_TIMEOUT_MS`, `WEBRTC_RECOVERY_ATTEMPTS`, and `WEBRTC_RECOVERY_BACKOFF_MS` in `.env`; numeric values are bounded by application configuration.

The offerer performs `restartIce()` where supported and sends a new SDP negotiation on the existing peer connection. The answerer requests that restart through authenticated signaling. Only the predetermined offerer generates offers, preventing offer glare. After 30 seconds of stable media, the retry budget resets for a later interruption. Exhaustion exposes the existing manual reconnect control; it never automatically chooses another stranger.

Offline signaling waits for online/subscription recovery. A brief signaling outage does not close healthy media or reacquire the camera. The server's existing 45-second heartbeat lease and one-hour session lifetime remain authoritative: recovery cannot resurrect an expired room. Stop, Next, membership changes and unmount abort signaling, invalidate the call, close the relevant peer, and cancel recovery, statistics and credential timers. A group peer failure does not rebuild unrelated edges. Group removal and room changes retain existing membership/epoch checks.

Negotiations retain retired round IDs and reject old offers/answers/ICE. Server-side instance retirement and signaling sequence checks remain in place. The client checks that async work still belongs to the current peer after awaited operations, and serializes local offer creation and incoming signaling.

## Mesh quality

Group capture starts at an ideal 640×360 / 20 fps; one-to-one capture can request 1280×720 / 24 fps. One local camera/microphone stream is shared across group edges, including camera switches. Group outbound video has a default aggregate target of at most 1.8 Mbps split over the current peer count (up to 600 kbps per edge). This is a video encoder budget, not a cap on total wire bandwidth: audio, encryption, retransmissions and transport overhead are additional.

Every eight seconds, connected edges sample packet loss, RTT and available outgoing bitrate. Poor links/data-saving/low-core devices lower video bitrate, frame rate and resolution. Improvements need three healthy samples to avoid rapid quality oscillation. Audio tracks remain active and are not downsampled by this adaptation. If sender parameters are unsupported, browser-native congestion control remains active. Memoized group peers avoid re-rendering for unrelated messages or heartbeat revisions. Zoom, fit/fill, expand, fullscreen, camera switching and the eight-person capacity are preserved.

Eight-way mesh still means seven outgoing media edges and seven incoming streams per device. Low-end phones, mobile uplinks, TURN bandwidth and browser behavior limit achievable quality. This remains mesh, not an SFU.

## Verification and manual checklist

Run `php artisan test --compact`, `npm run test:frontend`, `npm run build`, and `npx playwright test`. The browser suite needs Reverb on the configured port and uses synthetic camera/microphone devices with real peer connections and RTP. It launches an isolated application server on port 8001; do not start a second one if that test server is already running. For deliberate reuse only, set `DRIFT_REUSE_TEST_SERVER=true`. Browser file-cache rooms and throttles are stored under an isolated testing directory; user databases and normal local chat state are not flushed.

Manual checks on real devices:

1. Use two devices on different networks and HTTPS. Confirm two-way audio/video and text messages.
2. Verify forced-relay calls, expired credentials and refreshed credential issuance without exposing the TURN secret.
3. Briefly interrupt one device's network, restore it within the session lease, and check recovery into the same room.
4. Click Next or Stop while reconnecting; old media must stop and late signals must not restore it.
5. Join 3, 4 and 8 devices; verify seven remote tiles at capacity, stable audio and lower outbound video budgets. A ninth participant must receive another room.
6. Interrupt one group participant; healthy peer pairs should keep their connections. Refresh one participant and re-enable media; close it and confirm lease cleanup.
7. Check front/back switching, mute/unmute, camera off/on, digital zoom, fit/fill and fullscreen on Android Chrome and iOS Safari. Some devices cannot open the second camera while the first is active; verify on target devices.
8. Throttle bandwidth and add loss/latency. Inspect sender parameters and `getStats()` over at least 30 seconds, including quality recovery. Check console errors and CPU usage.

No physical-device or external TURN testing is implied by automated localhost tests.

Sources: [coturn configuration reference](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf), [WebRTC TURN setup](https://webrtc.org/getting-started/turn-server), [ICE restart](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/restartIce), [sender parameters](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/setParameters).
