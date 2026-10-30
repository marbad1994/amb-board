# amb-board

> Status: Phase 0 (audit) and Phase 1 (accounts, workspaces, roles, Life Areas, navy/teal shell) are implemented.
> See `docs/AUDIT.md` for the requirement checklist (most modules are still TODO), `docs/DECISIONS.md`, `docs/SECURITY.md`.


A self-hosted, mobile-first task board. Multiple projects, each with its own
board of draggable columns and cards, plus a shared idea board for loose
"post-it" style notes. Card and note descriptions support voice dictation in
English, Romanian or Swedish, with output always normalized to English.
Cards also support labels, and an "AI task" helper lets you describe a task
in plain speech (any of the three languages) and have the title, description,
owner, column and labels filled in automatically.

## Stack

- **Server**: Node.js + Express, SQLite (Node's built-in `node:sqlite`, no
  native build step), file uploads via multer.
- **Client**: React + Vite, drag-and-drop via `@dnd-kit`, mobile-first CSS
  (no CSS framework), icons via `lucide-react`.
- **Dictation**: browser Web Speech API (no external service, works offline
  per-browser support).
- **Translation**: server-side call to xAI's Grok API to translate dictated
  Romanian/Swedish text to English. Requires an API key (see below); without
  one, dictated non-English text is saved as-is.
- **AI task helper**: same xAI Grok API, prompted to extract a structured
  task (title, description, owner, column, labels) from a free-form
  description in English, Romanian or Swedish. Without the API key it falls
  back to a manual form pre-filled with the raw text.

## Requirements

- Node.js 22.5+ (uses the built-in experimental `node:sqlite` module).
- (Optional) an xAI API key (`X_GROK_API_KEY`) for AI translation.
- (Optional) [Tailscale](https://tailscale.com) installed on this machine and
  on the devices you want to reach it from, for access outside your LAN.

## Setup

```bash
npm install                 # installs root, server and client workspaces
cp server/.env.example server/.env
# edit server/.env and set X_GROK_API_KEY if you want AI translation
```

## Development

Runs the API server (port 3417) and the Vite dev server (port 5192, proxying
`/api` and `/uploads` to the API) together:

```bash
npm run dev
```

Open `http://localhost:5192` in your browser.

## Production (single server)

Build the client and serve everything from the Express server on one port:

```bash
npm run build     # builds client/dist
npm start         # serves API + built client from server (port 3417)
```

Open `http://localhost:3417`.

## Serving over Tailscale

The server binds to `0.0.0.0` by default, so it's reachable on your
tailnet automatically once Tailscale is running on this machine:

1. Install and log in to Tailscale on this machine: `sudo tailscale up`.
2. Find this machine's Tailscale IP or MagicDNS name:
   `tailscale ip -4` (or check the Tailscale admin console).
3. Run the app in production mode: `npm run build && npm start`.
4. From any other device on your tailnet, open
   `http://<tailscale-ip-or-name>:3417`.

For a stable, memorable URL you can instead use `tailscale serve`:

```bash
npm run build && npm start &
tailscale serve --bg 3417
```

This publishes the app at `https://<machine-name>.<tailnet-name>.ts.net`
with TLS handled by Tailscale, reachable from any device signed into your
tailnet — including over the internet, without opening any ports.

To stop serving: `tailscale serve --stop`.

## Accounts and workspaces

All API routes now require a signed-in account. The first account registered adopts any pre-existing
(pre-auth) projects and ideas into its personal workspace; register it before exposing the server.
Set `NODE_ENV=production` (or `COOKIE_SECURE=true`) when served over HTTPS, e.g. via `tailscale serve`.
Optional env: `ALLOWED_ORIGINS`, `CORS_ORIGIN`, `TRUST_PROXY=true`, `REGISTER_RATE_MAX`.

## Deploying to /opt/amb-board3

`deploy.sh` (run as root) pulls the latest code as `marcus` in `~marcus/amb-board`, syncs it to `/opt/amb-board3`, runs `npm install`, `npm run build` and starts the server in the background (stopping the previous instance first, waiting for `/api/health`). It never overwrites `server/.env`, `server/data` or `server/uploads`, and copies the data folder to `/opt/amb-board3.backups/` before each deploy.

```bash
sudo bash deploy.sh
```

Options (environment variables): `GIT_USER`, `SRC_DIR`, `DEST_DIR`, `BRANCH`, `PORT`, `RUN_AS` (run npm and the server as another user), `KEEP_BACKUPS`, `HEALTH_TIMEOUT`. Logs go to `/opt/amb-board3/amb-board.log`.
The deploy also maps `amb.makketing.com` to the app with an nginx reverse proxy (`/etc/nginx/conf.d/amb-board.conf`, or `sites-available` if that directory exists). The DNS record for the domain must already point at the server. Use `DOMAIN=other.example.com` to change it or `DOMAIN=` to skip it. For HTTPS run `sudo CERTBOT_EMAIL=you@example.com bash deploy.sh` (needs `certbot` and `certbot-nginx`); once a certificate exists later deploys keep the session cookie `Secure` automatically.

Do not set `NODE_ENV=production` unless the site is served over HTTPS: production mode makes the session cookie `Secure`, so logins fail over plain HTTP.

## Tests

```bash
npm test                      # server API tests (node:test, isolated temp DB)
npm run build && npm run e2e  # browser smoke test; needs Playwright available to Node
```

## Data & uploads

- SQLite database: `server/data/board.sqlite` (created automatically).
- Uploaded attachments: `server/uploads/` (served only through `/api/attachments/:id/download`).

Both are gitignored — back them up manually if you care about the data
(it's a single file + a folder, so a simple `cp -r` or `tar` works).

## Notes on dictation

Voice dictation uses the browser's built-in Speech Recognition API
(Chrome/Edge/Safari). Pick the language you're speaking (EN/RO/SV) with the
selector next to the microphone button on any description or comment field.
English speech is used as-is; Romanian and Swedish speech is sent to the
server's `/api/translate` endpoint and translated to English before being
inserted into the text field.

## AI task helper

On any project board, the "AI task" button opens a helper where you speak or
type what you want done, in English, Romanian or Swedish — mentioning who
should do it and any relevant context — then tap "Generate task". The
description is sent to `/api/ai/parse-task`, which asks Grok to translate it
and extract a title, description, owner, target column, and up to three
labels (reusing labels already used on the board where they fit). You can
edit any of the fields before creating the card. Labels are also editable
directly on any card, from its detail view.
