# Video calls through the temporary public tunnel

The public HTTPS page and private WSS signaling share the generated Quick Tunnel origin. Camera and microphone permission is restricted to that page's own origin. The browser still asks the visitor to grant permission. Existing CSRF, private-channel authorization and session ownership checks remain required for signaling.

The tunnel carries the website and WebRTC negotiation messages. Camera and microphone streams travel directly between peers, or through a configured TURN relay; Cloudflare Quick Tunnel is not a media relay. A successful same-machine browser test does not establish that calls work across arbitrary home, mobile or corporate networks.

## ICE and TURN settings

These optional settings belong in the existing `.env`. Do not replace its existing application or Reverb keys.

| Setting | Purpose |
| --- | --- |
| `STUN_URLS` | Comma-separated STUN URLs. Defaults to `stun:stun.l.google.com:19302`. |
| `TURN_URLS` | Comma-separated TURN URLs supplied by your TURN operator, for example UDP and TLS endpoints. |
| `TURN_SECRET` | TURN REST shared secret for compatible servers such as coturn. Remains on the Laravel server; Laravel issues time-limited credentials. |
| `TURN_TTL` | Time-limited credential lifetime in seconds; default 7200. |
| `TURN_USERNAME`, `TURN_PASSWORD` | Alternative static TURN credentials. These must reach the browser to authenticate its relay connection, so use dedicated restricted credentials rather than an administrative password. |
| `WEBRTC_ICE_TRANSPORT_POLICY` | `all` by default. Set `relay` with working TURN to require relay transport. |

Use TURN for reliable calling when direct peer connections are blocked. Direct WebRTC can reveal network addresses to the other participant; `relay` with a working TURN service is needed when hiding peer addresses is part of the anonymity requirement. No TURN server, paid account or credentials are installed automatically.

## Apply a new public build

The public runtime uses its own built frontend assets and dedicated Reverb process. An already-running runtime does not automatically adopt updated proxy headers or Reverb limits. End public access before restarting it:

```powershell
Set-Location 'D:\office work\project'
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\public-tunnel.ps1 -Action Stop
```

Keep the Redis terminal running. Then start the public runtime again:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\public-tunnel.ps1
```

This rebuilds the public frontend, starts dedicated loopback HTTP/Reverb/proxy processes, and prints a new temporary HTTPS link. Keep that terminal and Redis running. Share the new link; the hostname changes when a new Quick Tunnel is created. Use Ctrl+C or the Stop command to end public access. Local development servers are separate.

The reverse proxy allows only the website, built assets, authorized chat actions and Reverb socket route. `/chat/signal` has a bounded 128 KB request body; ordinary chat actions retain their 16 KB limit. Reverb's public request and message limits are 128 KiB to accommodate validated SDP envelopes. Camera, microphone and autoplay policies allow only the same origin; media streams are allowed by the content policy. Browser autoplay restrictions may still require a visitor gesture before remote audio plays.
