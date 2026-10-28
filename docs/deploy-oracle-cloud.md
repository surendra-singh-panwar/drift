# Drift production deployment on Oracle Cloud

This guide prepares a single Ubuntu VM for Laravel 12, PHP-FPM, Nginx, SQLite, file-backed matchmaking, Laravel Reverb, and optional coturn. It does not create an Oracle account, provision cloud resources, transfer your local database, or deploy the application.

## Readiness report

| Area | Current project state | Deployment implication |
|---|---|---|
| Application | Laravel 12, PHP `^8.2`, Inertia 2, React 19, Vite 6 | Ubuntu 24.04 LTS ARM64 with PHP 8.3 and a supported Node.js LTS is a compatible target. Composer and npm lockfiles are present. |
| Anonymous chat | Laravel session UUIDs identify users; `MatchmakingService` owns matching, state transitions, and expiry | Keep the existing application logic. Use one VM and one local file-cache directory; this matching snapshot is not a multi-server shared store. |
| Actual local state | The inspected `.env` selects `CHAT_STORE=file`, `CACHE_STORE=file`, `SESSION_DRIVER=file`, and `DB_CONNECTION=sqlite`. Its values were not printed or changed. | These are suitable for a single VM when `storage/` and the SQLite file persist and have correct permissions. |
| Example environment | `.env.example` currently says `CHAT_STORE=redis`, while the local `.env` and newer group/WebRTC docs support file storage | Set `CHAT_STORE=file` explicitly in the production `.env`. Do not start Redis unless you intentionally choose the Redis backend. |
| SQLite | `database/database.sqlite` exists locally; the schema includes conventional Laravel tables. Anonymous IDs and chat rooms are not stored in it. | Use a separate persistent server-side SQLite path. Do not upload or overwrite the local database; migrations do not need to import chat history. |
| Reverb | Echo/Pusher connects using the built `VITE_REVERB_*` settings. Laravel broadcasts to the endpoint in `REVERB_*`; events use `ShouldBroadcastNow`. | No queue worker is required for current broadcasts. Nginx should proxy only `/app/` to Reverb on loopback; do not expose port 8080 to the Internet. |
| WebRTC signaling/media | The app authorizes `/chat/signal` and `/chat/ice` against session, room, tab, and group membership. Signaling is relayed through Laravel/Reverb; media is peer-to-peer or TURN-relayed. | Use HTTPS/WSS. TURN is required for some NAT/firewall combinations; STUN alone cannot guarantee calls. |
| Group calls | Current service and tests enforce up to eight members; the browser uses WebRTC mesh, up to seven peer connections per device. Some older README/doc text describes four. | Keep eight as the existing limit. Eight-person calls can be demanding on endpoints and a TURN relay; there is no SFU. |
| Security controls | Chat routes already have session/IP limits; private Reverb channels, CSRF, ICE authorization, payload bounds, and strict room ownership checks are present. | Restrict Reverb origins, disable client-published events, enable Reverb message limiting, use secure cookies, and do not add wildcard CORS. |
| Existing deployment material | WebRTC/TURN operations exist in [`webrtc-deployment.md`](webrtc-deployment.md); Windows tunnel scripts are for local testing, not production hosting. No Nginx or Supervisor configuration existed. | Use the Linux examples added under `deploy/`. Do not run `artisan serve`, Vite dev server, the Windows scripts, or a public Reverb port in production. |
| Source publishing | The workspace currently has no Git repository. `.env`, `database/*.sqlite*`, and runtime/private storage are ignored by nested ignore files. | Create/use a private remote yourself; inspect the file list and ignore status before pushing. Never add `.env`, report files, or a local database. |

The `file` cache uses Laravel's filesystem lock implementation, which uses an exclusive file lock. It is suitable for the single-host arrangement below; it is not shared coordination across multiple VMs. The app prunes abandoned users on subsequent requests and uses TTLs; no scheduled cleanup or queue worker is required. Group reports are stored privately under local storage and should remain outside the public web root.

## Is Oracle Always Free suitable?

**Technically, yes, conditionally:** an eligible Ampere A1 VM has enough nominal resources for a small Laravel/Reverb deployment and coturn can run on that same VM. Oracle currently documents up to **1,500 A1 OCPU-hours and 9,000 GB-hours per month**, equivalent to **2 OCPUs and 12 GB RAM continuously**, and up to **200 GB total Always Free block volume**. A1 is ARM64; install ARM64 Ubuntu and verify all packages use the architecture. Two E2.1.Micro instances are also listed, but their small per-instance resources are not recommended for Drift plus TURN.

This is **not an uptime or cost guarantee**:

- Always Free A1 capacity can be unavailable in the home region. Oracle documents “out of host capacity” and advises trying another availability domain or waiting.
- Oracle can reclaim an Always Free VM it classifies as idle. Its documented test uses seven days where CPU p95, network utilization, and (for A1) memory utilization are each below 20%. Do not generate artificial traffic to evade this policy.
- Select only resources explicitly labelled Always Free and stay within the full shared tenancy limits. A1's 2 OCPUs/12 GB and the 200 GB block-volume allowance are tenancy-wide, not per application. The minimum A1 boot volume is 47 GB.
- A public website needs public ingress. The Always Free compute page is not a billing guarantee for every related networking resource. Before assigning a public IPv4 address or using outbound TURN bandwidth, inspect the current account/region rate card and estimate. **If the console shows any charge for a required resource, stop; do not upgrade or enable it.** A ₹0 total cannot be promised without that check and without a free/existing domain name.
- Oracle signup generally asks for a phone number and a credit/debit card that supports online authorization. A temporary verification hold may appear; Oracle says this is not a service charge. One free account per person is allowed. Do not upgrade to Pay As You Go for this plan.
- Oracle's Free Tier page says accounts inactive for 30 days or more may be suspended or terminated. The VM also has no SLA equivalent to paid production hosting.
- A paid domain would violate the strict ₹0 goal. Use a domain/hostname you already own or a genuinely free hostname; certificate issuance from Let's Encrypt is free.

Oracle is the best technical fit among the commonly available free plans because it gives a full VM, persistent local disk, long-running processes, and configurable UDP/TCP ingress. Free PaaS plans that sleep, have ephemeral local storage, or do not allow arbitrary UDP are not drop-in substitutes for Reverb plus reliable TURN. A free HTTP tunnel can expose the web app and WSS, but it does not relay WebRTC media or replace coturn. If A1 capacity or the networking cost gate fails, there is no alternative I can responsibly guarantee will meet **all** of these requirements at ₹0/month.

## Architecture

```text
Browsers
  HTTPS / WSS :443
       |
      Nginx -- PHP-FPM -- Laravel
       |           |       |-- SQLite: /var/lib/drift/database.sqlite
       |           |       |-- file sessions/cache/matchmaking: storage/
       |           |       `-- Reverb publishing to 127.0.0.1:8080
       `-- /app/* WebSocket proxy --> Reverb (127.0.0.1:8080)

Browsers -- WebRTC direct media when possible
Browsers -- STUN/TURN UDP/TCP --> coturn on this VM, only when needed
```

Coturn is optional for the first deployment, but video calls through restrictive NATs/firewalls may fail without it. TURN traffic uses the server's bandwidth. Peer-to-peer calls do not pass media through Laravel or Reverb.

## 1. Create and cost-check the Oracle account

1. Sign up at [Oracle Cloud Free Tier](https://www.oracle.com/cloud/free/). Use your own accurate identity and a card accepted by Oracle. Do not create a second account.
2. Choose the **home region** nearest the majority of your users; Always Free compute must be created there. Consider A1 capacity in that region before committing.
3. Keep the account on the Free Tier. Do not click **Upgrade**.
4. In the console's current rate card/estimate, verify the expected monthly total for the A1 shape, boot volume, public ingress address, and expected data transfer. The app requires direct HTTPS/WSS ingress and coturn requires public UDP/TCP reachability. If any required line item is not free, do not provision it for this ₹0 plan.
5. Do not rely on budgets as a hard spending cap. Review the Billing/Cost Analysis page after setup and regularly thereafter.

Official references: [Free Tier](https://www.oracle.com/cloud/free/), [Always Free limits and idle reclamation](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm), [account/trial details](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm), [public IP concepts](https://docs.oracle.com/en-us/iaas/Content/Network/Tasks/managingpublicIPs.htm), and [Oracle pricing](https://www.oracle.com/cloud/price-list/). Re-check them before provisioning because provider terms can change.

## 2. Create an Ubuntu VM

In **Compute → Instances → Create instance**:

1. Pick an Ubuntu 24.04 LTS **ARM64/AArch64** image.
2. Select `VM.Standard.A1.Flex`; set **2 OCPUs and 12 GB memory maximum total** for the Always Free A1 allowance. Verify the console's Always Free indicator before creating.
3. Allocate a boot volume of about 50 GB, within the 200 GB total allowance.
4. Use a public subnet and assign a public IPv4 only after the cost check above. Attach an SSH public key; keep its private key on your computer.
5. Add cloud ingress rules: TCP 22 only from your current public IP `/32`; TCP 80/443 from the Internet. If deploying coturn, also allow UDP and TCP 3478, TCP 5349, and the UDP relay range 49160–49260. Add IPv6 rules only if you configure and test IPv6.
6. Do not create a load balancer, paid volume, NAT gateway, or other paid resource for this single-VM setup.

Generate a key on Windows if needed, then paste the `.pub` contents into the instance wizard:

```powershell
ssh-keygen -t ed25519 -f "$HOME\.ssh\drift_oci" -C "drift-oci"
Get-Content "$HOME\.ssh\drift_oci.pub"
ssh -i "$HOME\.ssh\drift_oci" ubuntu@YOUR_PUBLIC_IP
```

Keep the private key private. Never paste it into chat, a Git repository, or the VM's web directory.

## 3. Install Ubuntu packages

On the VM:

```bash
sudo apt update
sudo apt full-upgrade -y
sudo apt install -y nginx supervisor certbot python3-certbot-nginx \
  git unzip curl ca-certificates gnupg composer \
  php8.3-cli php8.3-fpm php8.3-bcmath php8.3-curl php8.3-mbstring \
  php8.3-xml php8.3-sqlite3 php8.3-zip php8.3-intl php8.3-opcache
```

Install Node.js 22 LTS from the NodeSource APT repository (used only to build frontend assets):

```bash
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
sudo chmod 0644 /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
  | sudo tee /etc/apt/sources.list.d/nodesource.list
sudo apt update
sudo apt install -y nodejs
php -v
composer --version
node --version
npm --version
```

These commands install software on the VM; they do not enable paid OCI services. Use supported security updates and verify that PHP is 8.3 and Node.js is a supported LTS release.

## 4. Publish source and clone it

The current workspace is not a Git repository. From your computer, create a **private** Git remote that you control, initialize and push the source yourself, and inspect the files first:

```powershell
Set-Location 'D:\office work\project'
git init
git status --short --ignored
git add .
git status --short
```

The `.env`, local SQLite files, private storage, `vendor/`, `node_modules/`, and generated build output must not be added. If anything sensitive appears in the staged list, unstage it and fix the ignore rules before pushing. Then add your private remote and push (replace the URL):

```powershell
git branch -M main
git remote add origin YOUR_PRIVATE_GIT_REMOTE
git push -u origin main
```

For private repositories, use a dedicated read-only deploy key on the server rather than embedding a password or access token in the clone URL. Do not run `git clean` on the server.

On Ubuntu, create a deploy account, clone into the fixed application path, and keep persistent app data separate:

```bash
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG www-data deploy
sudo install -d -o deploy -g www-data -m 2750 /var/www
sudo -u deploy git clone YOUR_PRIVATE_GIT_REMOTE /var/www/drift
sudo install -d -o www-data -g www-data -m 2770 /var/lib/drift
sudo -u www-data touch /var/lib/drift/database.sqlite
```

`touch` leaves an existing database intact. If you have existing local SQLite records you specifically need, stop and plan a separate verified backup/import; this guide does not copy or replace them. Anonymous chat state and message text are intentionally not migrated.

## 5. Configure `.env`, PHP, and SQLite

Copy the example only if no server `.env` exists, then edit it locally on the VM. Do not paste secrets into a command line or commit them:

```bash
cd /var/www/drift
sudo -u deploy test -f /var/www/drift/.env || sudo -u deploy cp /var/www/drift/.env.example /var/www/drift/.env
sudo -u deploy nano /var/www/drift/.env
```

Set at least the following values. Replace hostnames; generate unique values for secrets on the server. Keep `TURN_SECRET` off the frontend:

```dotenv
APP_NAME=Drift
APP_ENV=production
APP_DEBUG=false
APP_URL=https://drift.example.com

DB_CONNECTION=sqlite
DB_DATABASE=/var/lib/drift/database.sqlite

SESSION_DRIVER=file
SESSION_SECURE_COOKIE=true
SESSION_HTTP_ONLY=true
SESSION_SAME_SITE=lax
SESSION_DOMAIN=null
CACHE_STORE=file
CHAT_STORE=file
QUEUE_CONNECTION=sync

LOG_CHANNEL=daily
LOG_LEVEL=warning
LOG_DAILY_DAYS=14

BROADCAST_CONNECTION=reverb
REVERB_APP_ID=drift-production
REVERB_APP_KEY=GENERATE_A_RANDOM_PUBLIC_KEY
REVERB_APP_SECRET=GENERATE_A_RANDOM_PRIVATE_SECRET
REVERB_HOST=127.0.0.1
REVERB_PORT=8080
REVERB_SCHEME=http
REVERB_SERVER_HOST=127.0.0.1
REVERB_SERVER_PORT=8080
REVERB_ALLOWED_ORIGINS=drift.example.com
REVERB_APP_ACCEPT_CLIENT_EVENTS_FROM=none
REVERB_APP_RATE_LIMITING_ENABLED=true
REVERB_APP_RATE_LIMIT_MAX_ATTEMPTS=60
REVERB_APP_RATE_LIMIT_DECAY_SECONDS=60

VITE_REVERB_APP_KEY="${REVERB_APP_KEY}"
VITE_REVERB_HOST=drift.example.com
VITE_REVERB_PORT=443
VITE_REVERB_SCHEME=https

STUN_URLS=stun:stun.l.google.com:19302
TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp
TURN_SECRET=THE_SAME_RANDOM_SECRET_CONFIGURED_FOR_COTURN
TURN_TTL=1800
WEBRTC_ICE_TRANSPORT_POLICY=all
```

Generate a random `APP_KEY` once with `sudo -u deploy php artisan key:generate` after the `.env` is in place. Generate independent random Reverb and TURN secrets with `openssl rand -hex 32`, then enter them directly into the protected server configuration; never reuse `APP_KEY` as either secret. Do not run key generation again during normal deployment: changing `APP_KEY` invalidates existing encrypted data and sessions.

`REVERB_HOST/PORT/SCHEME` are the private Laravel-to-Reverb target. `VITE_REVERB_HOST/PORT/SCHEME` are public browser settings, compiled into the frontend for HTTPS/WSS. Do not set `VITE_REVERB_APP_SECRET` or `VITE_TURN_SECRET`. Reverb accepts only the website hostname as an origin; use a hostname, not a URL with scheme or path.

Set ownership and restrictive permissions. Laravel needs write access only to runtime storage, `bootstrap/cache`, and the separate database directory:

```bash
sudo chown -R deploy:www-data /var/www/drift
sudo find /var/www/drift -type d -exec chmod 2750 {} +
sudo find /var/www/drift -type f -exec chmod 0640 {} +
sudo chown deploy:www-data /var/www/drift/.env
sudo chmod 0640 /var/www/drift/.env
sudo chown -R deploy:www-data /var/www/drift/storage /var/www/drift/bootstrap/cache
sudo find /var/www/drift/storage /var/www/drift/bootstrap/cache -type d -exec chmod 2770 {} +
sudo find /var/www/drift/storage /var/www/drift/bootstrap/cache -type f -exec chmod 0660 {} +
sudo chown -R www-data:www-data /var/lib/drift
sudo chmod 2770 /var/lib/drift
sudo chmod 0660 /var/lib/drift/database.sqlite
```

Do not run `chmod -R 777`. Keep private reports under `storage/app/private`; do not run `storage:link` for private files.

## 6. Install dependencies, build assets, and migrate

Run Composer and npm as the deploy user. The built frontend needs the public `VITE_REVERB_*` values already present in `.env`:

```bash
cd /var/www/drift
sudo -u deploy composer install --no-dev --prefer-dist --no-interaction --optimize-autoloader
sudo -u deploy npm ci
sudo -u deploy npm run build
sudo -u deploy php artisan migrate --force
sudo -u deploy php artisan config:cache
```

The SQLite database is new and external to the checkout. `migrate --force` applies pending migrations; it does not copy the local database or save anonymous chat history. Back up `/var/lib/drift/database.sqlite` before future schema changes. The single-host file cache is also the lock/state backend; do not run multiple app VMs against separate file caches.

## 7. Configure Nginx and HTTPS/WSS

Point DNS A records for `drift.example.com` and `turn.example.com` to the VM's public IP. If using a DNS provider with an HTTP proxy toggle, leave the TURN name DNS-only; proxying does not carry coturn's UDP relay traffic.

Bootstrap with the HTTP example, replacing both hostnames and confirming the PHP-FPM socket version:

```bash
sudo cp /var/www/drift/deploy/nginx/drift-http.conf.example /etc/nginx/sites-available/drift
sudo nano /etc/nginx/sites-available/drift
sudo ln -s /etc/nginx/sites-available/drift /etc/nginx/sites-enabled/drift
sudo nginx -t
sudo systemctl enable --now nginx php8.3-fpm
sudo systemctl reload nginx
sudo certbot --nginx --redirect -d drift.example.com -d turn.example.com
```

After Certbot has obtained the certificate, install the final HTTPS configuration and replace every example hostname:

```bash
sudo cp /var/www/drift/deploy/nginx/drift-https.conf.example /etc/nginx/sites-available/drift
sudo nano /etc/nginx/sites-available/drift
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl enable --now certbot.timer
```

The final config serves Laravel through PHP-FPM, redirects HTTP to HTTPS, returns 404 for the built-in `/up` health endpoint, blocks hidden files, and proxies only `/app/` WebSocket requests to Reverb on `127.0.0.1:8080`. It does not expose Reverb's event-publishing API or its listen port. Laravel's secure session cookie setting and Nginx HTTPS FastCGI parameter ensure cookies are sent only over TLS.

Verify certificate renewal with `sudo certbot renew --dry-run`. If coturn is using the same certificate for TLS, configure a Certbot deploy hook to reload coturn after renewal.

## 8. Run Reverb continuously

Install the included Supervisor program definition:

```bash
sudo install -d -o root -g www-data -m 0750 /var/log/drift
sudo cp /var/www/drift/deploy/supervisor/drift-reverb.conf.example /etc/supervisor/conf.d/drift-reverb.conf
sudo supervisorctl reread
sudo supervisorctl update
sudo systemctl enable --now supervisor
sudo supervisorctl status drift-reverb
```

The process binds only to loopback, restarts on failure, and starts again after reboot. Nginx handles WSS at the public HTTPS origin. Confirm that TCP 8080 is not allowed in the OCI security list or UFW. Reverb uses `ShouldBroadcastNow`, so no queue worker is needed for current chat events. There is also no scheduled cleanup command; active requests and TTLs handle abandoned state.

## 9. Optional coturn relay on the same VM

The existing application already issues short-lived coturn REST credentials from `TURN_SECRET`, and authorizes ICE-configuration requests only for an active video room. Use the complete [coturn setup and relay security guidance](webrtc-deployment.md#production-coturn-setup); do not put its shared secret in Git or a `VITE_` variable.

For this single-VM arrangement:

1. Install coturn with `sudo apt install coturn`. On Ubuntu packages that gate service startup through `/etc/default/coturn`, set `TURNSERVER_ENABLED=1`.
2. Create `turn.example.com` DNS pointing directly to this VM and obtain a TLS certificate that includes that hostname.
3. Configure coturn with authenticated TURN REST credentials using the same random secret as `TURN_SECRET`; do not allow unauthenticated relay or public access to its CLI.
4. Start coturn only after checking its config and firewall rules. Keep its credentials/config readable only by the coturn service and root.
5. Allow inbound UDP/TCP 3478, TCP 5349, and the configured UDP relay range (the included operational example uses 49160–49260) in both UFW and the OCI network security list. Do not expose unrelated ports.
6. Enable/reload coturn at boot and arrange a certificate-renewal reload. For example, create `/etc/letsencrypt/renewal-hooks/deploy/reload-coturn` containing `#!/bin/sh` followed by `systemctl reload coturn || systemctl restart coturn`, then make the hook executable with `sudo chmod 0750 /etc/letsencrypt/renewal-hooks/deploy/reload-coturn`. Watch CPU, memory, allocations, and network/bandwidth; start with conservative coturn quotas.
7. Leave `WEBRTC_ICE_TRANSPORT_POLICY=all` for normal operation. Temporarily use `relay` only for a forced-relay verification, then restore `all` unless relay-only behavior is a deliberate privacy choice.

Coturn can fit nominally on A1, but a free VM does not promise enough bandwidth for sustained relayed video. One eight-person mesh room can cause each browser to send to and receive from up to seven peers; if those links relay, traffic crosses coturn. TURN is necessary for some network pairs, not all. If coturn is unavailable, those users may fail to connect. If bandwidth is exhausted or the VM is throttled/reclaimed, video quality and availability degrade. Drift has no SFU to reduce mesh load.

## 10. Host firewall and service checks

Configure UFW only after allowing SSH from your own current public IP. Add the same ports in the OCI VCN security list; both firewalls must permit the traffic:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from YOUR_PUBLIC_IP/32 to any port 22 proto tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
# Only when coturn is installed:
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw allow 5349/tcp
sudo ufw allow 49160:49260/udp
sudo ufw enable
sudo ufw status verbose
```

Do not enable the TURN rules if coturn is not configured. Do not open 8080, 8000, 5173, 6379, 3306, or 5432 to the Internet. If you lose SSH after enabling UFW, use the Oracle VM console rather than opening all ports.

Set `LOG_CHANNEL=daily` and a reasonable `LOG_DAILY_DAYS` in `.env`; Laravel will rotate its daily files. Ubuntu normally configures logrotate for Nginx. Supervisor rotates its own Reverb log as defined in the supplied file. Keep logs and reports private and set a retention policy.

After any environment change:

```bash
cd /var/www/drift
sudo -u deploy php artisan config:cache
sudo supervisorctl restart drift-reverb
sudo systemctl reload php8.3-fpm
```

When deploying a code update, do not overwrite `.env` or the database. Use `git pull --ff-only`, install locked dependencies, rebuild assets, run pending migrations after a verified backup, refresh the config cache, and restart Reverb. Do not regenerate `APP_KEY`.

## 11. Production verification checklist

- [ ] OCI Billing/Cost Analysis shows only the intended Always Free resources and no unapproved charge. Recheck after assigning public IPv4 and after video tests.
- [ ] `sudo nginx -t`, `sudo systemctl status nginx php8.3-fpm supervisor`, and `sudo supervisorctl status drift-reverb` succeed.
- [ ] `ss -lntup` shows Reverb bound to `127.0.0.1:8080`, not `0.0.0.0:8080`.
- [ ] `curl -I https://drift.example.com` succeeds with a valid certificate; `http://drift.example.com` redirects to HTTPS.
- [ ] `https://drift.example.com/.env`, `/vendor/`, `/artisan`, and `/up` are not served.
- [ ] Browser DevTools shows an HTTPS page and a successful `wss://drift.example.com/app/...` connection; no `ws://` or mixed-content requests.
- [ ] Use two independent browser profiles to test random text matching, bidirectional messages, Next/Stop, refresh recovery, and a private-channel reconnect. Messages should not be expected to replay after disconnection.
- [ ] Grant camera/microphone on HTTPS and test calls between devices on different networks, not only browsers on the same LAN. Confirm mute, camera-off, stop, device permissions, recovery, and cleanup.
- [ ] Join a group with up to eight independent sessions and verify that a ninth is placed in another room. Expect mesh CPU and bandwidth limits on phones and free servers.
- [ ] With coturn, force `relay` temporarily and confirm the selected ICE candidate pair is `relay`; test both UDP and TURN/TLS fallback. Restore `all` afterwards.
- [ ] Reboot the VM and verify Nginx, PHP-FPM, Supervisor/Reverb, coturn (if installed), and TLS renewal timer return automatically.
- [ ] Monitor free-tier usage, idle-reclamation notifications, disk space, SQLite backups, Laravel logs, coturn allocations, and network egress.

Automated browser tests and localhost calls do not prove worldwide reachability or TURN reliability. This guide has not deployed or remotely tested Drift.
