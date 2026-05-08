# TaskSmith Server Deployment Notes

## Host

Dedicated Hetzner host:

```txt
SSH alias: tasksmith
IP: 178.105.101.73
Primary user: deploy
Application root: /opt/tasksmith/app
Run data root: /opt/tasksmith/data
Service: tasksmith.service
Public bind: none yet; app listens on 127.0.0.1:3000
```

## Baseline hardening applied

- Created non-root `deploy` user.
- Configured `deploy` for passwordless sudo.
- Switched local SSH alias `tasksmith` to `deploy` using `~/.ssh/hetzner-personal`.
- Disabled SSH password and keyboard-interactive authentication.
- Disabled root SSH login after verifying `deploy` access.
- Enabled UFW with inbound `22`, `80`, and `443` only.
- Installed and enabled `fail2ban`.
- Enabled unattended upgrades.
- Added 4 GiB swapfile.
- Set basic inotify limits for repo/test workloads.
- Created `/opt/tasksmith/{app,data,secrets}` owned by `deploy`.

## Current runtime model

TaskSmith now runs directly on the host through systemd, not through Docker.

Installed host tooling:

```txt
node v24.14.0
npm 11.9.0
pnpm 10.5.1
pi 0.73.0
```

`pi` is installed from npm package `@mariozechner/pi-coding-agent`. Do not install the Ubuntu `pi` package; it is unrelated.

`pi update` may report that self-update is unavailable because this is a root/global npm-managed install. Update Pi explicitly with sudo/npm when needed, or switch later to a deploy-user npm prefix if we want self-updates.

The systemd unit template is tracked at:

```txt
deploy/tasksmith.service
```

Active service:

```bash
systemctl status tasksmith
curl -fsS http://127.0.0.1:3000/healthz
```

## Pi auth model

Because this is a dedicated TaskSmith server, `deploy` can run Pi directly:

```bash
ssh tasksmith
pi
```

Use Pi's normal `/login` flow as `deploy`. That creates auth under:

```txt
/home/deploy/.pi/agent
```

TaskSmith is configured with:

```txt
TASKSMITH_PI_AUTH_SOURCE=/home/deploy/.pi/agent
```

For each Run, TaskSmith copies only narrow Pi auth/config material into the per-run directory. It must not mount or copy the full deploy home directory.

## Direct host deployment/test commands

From local machine:

```bash
rsync -az --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude .data \
  --exclude .env \
  --exclude '.env.*' \
  --exclude .omc \
  ./ tasksmith:/opt/tasksmith/app/
```

On the server:

```bash
cd /opt/tasksmith/app
pnpm install --frozen-lockfile
pnpm typecheck
pnpm typecheck:web
pnpm build                  # produces src/server/public/{index.html,assets/*}
pnpm e2e:manual-run
pnpm e2e:verifier
pnpm e2e:pi-spike
sudo systemctl restart tasksmith
curl -fsS http://127.0.0.1:3000/healthz
```

The systemd unit also runs `pnpm build` in `ExecStartPre` as a deploy-safety net. Running it manually before restart is still recommended so asset or type errors are visible before service restart. The SPA is served as static files from `src/server/public/`.

Authenticated Pi e2e on the server requires first logging in with host Pi as `deploy`:

```bash
ssh tasksmith
pi
# /login
```

This has been completed with ChatGPT auth. The authenticated server e2e now passes:

```bash
cd /opt/tasksmith/app
TASKSMITH_REAL_PI_E2E=1 pnpm e2e:pi-spike
```

A real Pi manual Run was also created through the TaskSmith API and verified in the browser UI through an SSH tunnel. Marker: `SERVER_REAL_PI_OK`. Screenshot artifact:

```txt
/tmp/tasksmith-server-real-pi-ui.png
```

## UI access

TaskSmith is exposed to the tailnet with Tailscale Serve while the app itself remains bound to localhost.

Tailnet URL:

```txt
https://tasksmith.tail1a218f.ts.net/
```

Tailscale details:

```txt
Tailscale IPv4: 100.78.63.18
Tailscale DNS: tasksmith.tail1a218f.ts.net.
Serve: https://tasksmith.tail1a218f.ts.net/ -> http://127.0.0.1:3000
```

To view the UI, connect your device to the same Tailscale tailnet and open:

```bash
open https://tasksmith.tail1a218f.ts.net/
```

SSH tunnel fallback:

```bash
ssh -L 3000:127.0.0.1:3000 tasksmith
open http://127.0.0.1:3000
```

Browser e2e with `agent-browser` has been run against both the direct SSH tunnel and the Tailscale Serve URL. Screenshot artifacts:

```txt
/tmp/tasksmith-host-direct-ui.png
/tmp/tasksmith-tailscale-ui.png
/tmp/tasksmith-phase3-tailscale-ui.png
```

After UI auth exists, we can decide whether to keep Tailscale-only access or also route Caddy/Nginx to the API/UI service and expose a public HTTPS URL.

## Docker status

Docker is installed and still available for future sandboxing, but TaskSmith itself is currently running directly on the host. The previous Docker Compose TaskSmith container was stopped.

Docker will likely become useful later for per-run sandboxes, verifier isolation, or browser/e2e containers.

## Security notes

- Keep Pi auth, Git deploy keys, Jira tokens, and Git provider tokens narrow.
- Per-run Pi auth/session directories belong under `/opt/tasksmith/data/runs/<run-id>/`.
- Never mount `/home/deploy` into agent sandboxes.
- The UI is not exposed publicly until authentication is added.
