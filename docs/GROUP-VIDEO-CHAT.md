# Random group video chat

> Current configuration, recovery, mesh-quality and testing guidance: [WebRTC operations](webrtc-deployment.md). Group capacity is now eight; local file storage does not require Redis. Historical implementation notes below may describe the earlier behavior.

## Architecture and existing components

The application uses Laravel 12/PHP 8.2+, React 19/Inertia 2, Tailwind/Vite, Laravel Reverb, and Redis through Predis. Existing anonymous session authentication, private personal channels, CSRF validation, tab ownership, heartbeat recovery, SDP preservation, STUN/TURN configuration, media controls and one-to-one matching remain in use. There is no external media server and no recording or database schema change.

The third mode is `group`. Text, one-to-one video and group users share the same ownership record, preventing concurrent modes for one session. Group rooms use a mode discriminator in the existing Redis snapshot. Every transition uses the existing `chat:transition` lock; capacity checks and membership updates are atomic. The fullest eligible room below four members is selected, with random ties. Otherwise one occupied waiting room is created. A singleton waits for a second participant before making any peer connection. Empty rooms are removed.

Next group excludes the room just left. It chooses an alternative partial room if available, otherwise creates a singleton waiting room; it never creates an empty room. Other members keep their room. Stop removes only the departing member. Existing member identities and membership generations remain stable when another member joins/leaves, so their existing calls continue.

Each join receives a fresh membership-generation UUID. Heartbeats every ten seconds renew the 45-second lease. Expired participants are pruned on subsequent requests; active peers discover departures through events or their own heartbeat. The one-hour absolute identity lifetime and snapshot TTL remain in force. Duplicate tabs are rejected using the existing tab token and Web Lock. Blocks last for the anonymous identity's current Redis lifetime and are checked in both directions when selecting groups.

## Native WebRTC mesh

Each participant captures one camera/microphone stream. GroupVideoPanel renders a GroupPeer for each other member, using the existing useVideoCall hook with a shared stream. A ref map keyed by participant identity routes signaling and immediate close operations. Room and membership-generation keys prevent stale component reuse. An eight-person room has up to 28 two-way peer connections in total, seven per browser.

The lexicographically greater anonymous UUID offers to the smaller UUID; the server enforces the same rule. Each pair serializes signaling and negotiation, queues early ICE, and uses independent connection-instance/negotiation IDs and replay counters. Group ICE candidates are collected over 100 ms and sent in validated batches of at most ten. This avoids excessive HTTP/Reverb bursts when all six mesh edges form together. Group signal requests allow 30 seconds and initial connection attempts allow 60 seconds; one-to-one defaults remain unchanged. A joining participant adds edges only to current members. A departure closes only that participant's edges. Next immediately cancels all old edges/signaling but keeps local capture. Stop/device loss/pagehide/unmount also stop owned tracks. Peer components never stop the shared capture stream belonging to their parent.

Refresh recovers authoritative membership and offers an Enable camera and microphone button. A private Reverb reconnect triggers heartbeat validation and fresh per-pair negotiation; unaffected pairs remain intact. Failed peer connections expose an individual reconnect control. The deterministic initiator also retries a failed group edge automatically, at most twice until a successful connection, without replacing other edges. A transient heartbeat HTTP failure preserves healthy mesh connections while the private socket and a recently server-validated 45-second lease remain valid. Ownership conflicts, socket loss and lease expiry still disable calls. Muting/disabling camera updates the shared track once, affecting every mesh edge.

## Signaling and messaging

All events use existing authorized private `anonymous.{id}` Reverb channels, not a new server or public room channel. Group membership snapshots announce room joins, participant joins and departures. Empty rooms are deleted and Stop resets the departing browser through its authoritative response. Moderator removals send an explicit ended event. Heartbeat membership snapshots repair lost events.

`/chat/signal` requires the sender's active room, tab token, target identity, both membership generations, valid payload and sequence number. SDP/ICE are forwarded only to that target. Per-directed-pair counters reject replayed and retired instances. No SDP, ICE, message bodies or media are retained in Redis. Signaling limits allow three peers per browser (720 requests/minute/session, 3000/minute/IP) while ordinary actions retain existing limits.

Group messages fan out to other current members with sender identity and UUID deduplication. Clients render message text through React and clear history on room change. Old-room and old-membership requests are rejected even if the same identities rejoin. UUIDs identify peers but do not authorize access.

## Reports, blocks and confirmed removal

Each remote tile offers Report and Block and leave. Reports require current group membership and a reason of 3–1000 characters. Reports persist as private JSON records on Laravel's local disk under `storage/app/private/chat-reports`. They contain reporter/target identities, room ID, reason, timestamps and review status, never media. No public report-reading or moderation endpoint exists. Do not publish this storage directory.

Reporting alone never removes anyone. Blocking moves the blocker into another eligible group, leaving the reported participant and others connected. The mutual matchmaking exclusion lasts for the current anonymous identity lifetime; clearing cookies or identity expiry defeats it. This is not an account-level ban.

An operator with trusted server shell access can review and explicitly confirm abuse:

```powershell
php artisan chat:review-report REPORT_UUID
php artisan chat:review-report REPORT_UUID --remove --confirm
```

The second command removes the target only from the reported room if still present, records the decision, and prevents that identity rejoining that room while it exists. It never removes the participant from some later unrelated room. The private record stores its server-generated matching namespace; the moderator command uses that namespace automatically, including public tunnel rooms. No automatic action is based on an unverified report. Operators should establish review, retention and access policies before production use. Multi-instance deployments require shared/private report storage and a moderation workflow.

## Four-session local test

Reuse running services. If not running, from `D:\office work\project`, keep these in two separate PowerShell terminals:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-redis.ps1
```

```powershell
composer run dev
```

1. Create four independent cookie sessions: for example Chrome Profile A, Chrome Incognito, Chrome Profile B and another browser/profile. Two windows sharing the same Incognito cookie session are not independent and should be rejected as duplicate tabs.
2. Open http://127.0.0.1:8000 in each. Select Group video chat, Start chat, then allow camera/microphone.
3. The first participant waits. The second connects to the first. At four members, each browser shows its local video plus three remote videos and `4/4 participants`.
4. Send a message; the other three should receive it once. Toggle microphone/camera and check the change on all peers. Use headphones.
5. Add a fifth independent session: it waits in another room rather than entering the full room.
6. Click Next group on one of the four: it joins the fifth participant, while the other three keep their existing calls. Its local camera stays active.
7. Stop one participant. Their media ends; others remain connected. Stop the last occupant to remove the room.
8. Refresh and enable media again, toggle offline/online, close a tab and wait about 45–55 seconds for lease cleanup. Try a duplicate tab, rapid controls, reporting and blocking. A report must not remove its target.

Physical devices may not allow simultaneous capture by four local browser sessions. Prefer four devices for manual testing. Phones and remote devices require HTTPS/WSS; a plain LAN HTTP address does not provide browser media access. STUN does not guarantee cross-network connectivity; configure TURN using docs/VIDEO-CHAT.md. Relay-only mode is needed if peer network addresses must be hidden.

## Automated verification

```powershell
$env:RUN_REDIS_TESTS = '1'
php artisan test
Remove-Item Env:RUN_REDIS_TESTS
npm.cmd run build
npm.cmd run test:browser
```

Backend tests cover capacity, join/leave, Next, signaling recipients/roles/replays, old membership generations, deduplicated group text, expiry, duplicate tabs, reports, blocks and confirmed moderator removal. Real Redis concurrency launches forty processes for twenty identities and asserts five rooms of four unique members. It uses an isolated prefix and removes only its test snapshot.

Chrome group tests use simulated media with real RTCPeerConnection, ICE/DTLS/RTP and decoded frames. They check all six edges in a full room, single capture per browser, preserved edges on joins/leaves, fifth visitor isolation, text, reporting without automatic removal, Next/Stop, refresh, real offline/online recovery and lease expiry. Existing text and one-to-one video tests remain part of the suite. Intentional offline and late stale-signaling rejections are distinguished from unexpected errors.

The browser server uses built assets and isolated Redis prefixes on port 8001; no duplicate development servers or Redis flush are needed. Mesh is intentionally limited to four: upload bandwidth, encoding and decoding grow with participant count. No physical-camera, listening-quality, mobile/Safari or cross-network TURN claims should be inferred from simulated Chrome tests.

## Files

Modified: app/Services/MatchmakingService.php; app/Http/Controllers/ChatController.php; app/Providers/AppServiceProvider.php; routes/web.php; resources/js/app.jsx; resources/js/use-video-call.js; resources/js/VideoPanel.jsx; resources/css/app.css; tests/Feature/RedisConcurrencyTest.php; tests/Support/match-worker.php; scripts/tunnel.Caddyfile; README.md; generated frontend build assets.

New: resources/js/GroupVideoPanel.jsx; app/Console/Commands/ReviewChatReport.php; tests/Feature/GroupChatTest.php; tests/Browser/group.spec.js; docs/GROUP-VIDEO-CHAT.md.

The existing public runtime requires restart to adopt updated proxy routes for report/block, followed by a new public frontend build. Local .env credentials are unchanged. No migrations, external media services, database deletes or Redis flush were introduced.
