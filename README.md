# amb-board

A self-hosted, mobile-first task board. Multiple projects, each with its own
board of draggable columns and cards, plus a shared idea board for loose
"post-it" style notes. Card and note descriptions support voice dictation in
English, Romanian or Swedish, with output always normalized to English.

## Stack

- **Server**: Node.js + Express, SQLite (Node's built-in `node:sqlite`, no
  native build step), file uploads via multer.
- **Client**: React + Vite, drag-and-drop via `@dnd-kit`, mobile-first CSS
  (no CSS framework), icons via `lucide-react`.
- **Dictation**: browser Web Speech API (no external service, works offline
  per-browser support).
- **Translation**: server-side call to Anthropic's API to translate dictated
  Romanian/Swedish text to English. Requires an API key (see below); without
  one, dictated non-English text is saved as-is.

## Requirements

- Node.js 22.5+ (uses the built-in experimental `node:sqlite` module).
- (Optional) an Anthropic API key for AI translation.
- (Optional) [Tailscale](https://tailscale.com) installed on this machine and
  on the devices you want to reach it from, for access outside your LAN.

## Setup

```bash
npm install                 # installs root, server and client workspaces
cp server/.env.example server/.env
# edit server/.env and set ANTHROPIC_API_KEY if you want AI translation
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

## Data & uploads

- SQLite database: `server/data/board.sqlite` (created automatically).
- Uploaded attachments: `server/uploads/`.

Both are gitignored — back them up manually if you care about the data
(it's a single file + a folder, so a simple `cp -r` or `tar` works).

## Notes on dictation

Voice dictation uses the browser's built-in Speech Recognition API
(Chrome/Edge/Safari). Pick the language you're speaking (EN/RO/SV) with the
selector next to the microphone button on any description or comment field.
English speech is used as-is; Romanian and Swedish speech is sent to the
server's `/api/translate` endpoint and translated to English before being
inserted into the text field.
