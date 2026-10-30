#!/usr/bin/env bash
# Deploy AMB Board:
#   1. as the git user (default: marcus) pull the latest code in ~/amb-board
#   2. back as the current user (root), sync that code into /opt/amb-board3
#   3. npm install, npm run build, npm start (restarting the old instance)
#
# Run it as root (su needs it):   sudo bash deploy.sh
# Settings can be overridden with environment variables, e.g.:
#   sudo GIT_USER=marcus DEST_DIR=/opt/amb-board3 PORT=3417 bash deploy.sh
#
# Public address: DOMAIN (default amb.makketing.com) is served by Caddy as a reverse proxy to the app, with automatic HTTPS
# (Caddy gets and renews the certificate itself). Set DOMAIN= (empty) to skip. Needs: caddy installed, the domain's DNS record
# pointing at this server, and ports 80 and 443 open. Optional: ACME_EMAIL=you@example.com for certificate expiry notices.
#
# Never overwritten or deleted in the destination: server/.env, server/data (your database),
# server/uploads (attachments and documents), node_modules. The database is also copied to a
# timestamped backup before every deploy (the app additionally backs it up before any migration).

set -euo pipefail

GIT_USER="${GIT_USER:-marcus}"
SRC_DIR="${SRC_DIR:-/home/${GIT_USER}/amb-board}"
DEST_DIR="${DEST_DIR:-/opt/amb-board3}"
BRANCH="${BRANCH:-}"                 # empty = whatever branch is checked out in SRC_DIR
RUN_AS="${RUN_AS:-}"                 # optional: run npm and the server as this user instead of the current one
KEEP_BACKUPS="${KEEP_BACKUPS:-5}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-40}"
DOMAIN="${DOMAIN-amb.makketing.com}"   # "-" not ":-": an explicitly empty DOMAIN disables the mapping
ACME_EMAIL="${ACME_EMAIL:-}"
CADDY_DIR="${CADDY_DIR:-/etc/caddy}"

PID_FILE="${DEST_DIR}/.amb-board.pid"
LOG_FILE="${DEST_DIR}/amb-board.log"
BACKUP_ROOT="${DEST_DIR}.backups"

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (for example: sudo bash $0). 'su ${GIT_USER}' needs it."
command -v git  >/dev/null || die "git is not installed"
command -v node >/dev/null || die "node is not installed"
command -v npm  >/dev/null || die "npm is not installed"
id "$GIT_USER" >/dev/null 2>&1 || die "user '${GIT_USER}' does not exist"
[ -d "${SRC_DIR}/.git" ] || die "${SRC_DIR} is not a git checkout"

# Run a command as another user with a login shell (su - ...). Arguments are quoted safely.
as_user() {
  local user="$1"; shift
  local cmd; cmd="$(printf '%q ' "$@")"
  su - "$user" -c "$cmd"
}

# ---------------------------------------------------------------- 1. pull as the git user
log "Pulling latest code as ${GIT_USER} in ${SRC_DIR}"
if [ -n "$BRANCH" ]; then
  as_user "$GIT_USER" git -C "$SRC_DIR" fetch --prune origin
  as_user "$GIT_USER" git -C "$SRC_DIR" checkout "$BRANCH"
fi
as_user "$GIT_USER" git -C "$SRC_DIR" pull --ff-only
COMMIT="$(as_user "$GIT_USER" git -C "$SRC_DIR" rev-parse --short HEAD)"
log "Now at commit ${COMMIT} (git user session ended)"

# ---------------------------------------------------------------- 2. sync into /opt
mkdir -p "$DEST_DIR"
if [ ! -f "${DEST_DIR}/server/.env" ]; then
  warn "${DEST_DIR}/server/.env does not exist. Create it (see server/.env.example) with your API keys; the server still starts without it."
fi

if [ -d "${DEST_DIR}/server/data" ]; then
  stamp="$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP_ROOT"
  log "Backing up the database to ${BACKUP_ROOT}/data-${stamp}"
  cp -a "${DEST_DIR}/server/data" "${BACKUP_ROOT}/data-${stamp}"
  # keep only the newest N backups
  # shellcheck disable=SC2012
  ls -1dt "${BACKUP_ROOT}"/data-* 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm -rf
fi

log "Syncing ${SRC_DIR} -> ${DEST_DIR}"
EXCLUDES=(--exclude '.git/' --exclude 'node_modules/' --exclude 'client/dist/' --exclude 'server/data/' --exclude 'server/uploads/'
          --exclude 'server/.env' --exclude '.env' --exclude '*.log' --exclude '.amb-board.pid' --exclude '.start.sh')
if command -v rsync >/dev/null; then
  rsync -a --delete "${EXCLUDES[@]}" "${SRC_DIR}/" "${DEST_DIR}/"
else
  warn "rsync not found; falling back to tar (files deleted upstream will not be removed here)"
  tar -C "$SRC_DIR" --exclude='.git' --exclude='node_modules' --exclude='client/dist' --exclude='server/data' \
      --exclude='server/uploads' --exclude='server/.env' --exclude='.env' --exclude='*.log' --exclude='.start.sh' -cf - . | tar -C "$DEST_DIR" -xf -
fi
mkdir -p "${DEST_DIR}/server/data" "${DEST_DIR}/server/uploads"
if [ -n "$RUN_AS" ]; then chown -R "$RUN_AS": "$DEST_DIR"; fi

# run a command inside DEST_DIR as the app user (RUN_AS) or as the current user
in_dest() {
  if [ -n "$RUN_AS" ]; then su - "$RUN_AS" -c "cd '${DEST_DIR}' && $*"; else (cd "$DEST_DIR" && bash -c "$*"); fi
}

# ---------------------------------------------------------------- stop the previous instance
stop_old() {
  [ -f "$PID_FILE" ] || return 0
  local pid; pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    log "Stopping the running instance (pid ${pid})"
    kill -TERM -- "-${pid}" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true   # whole process group: npm + node
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -0 "$pid" 2>/dev/null && { warn "instance did not stop in 10 s, killing it"; kill -KILL -- "-${pid}" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; }
  fi
  rm -f "$PID_FILE"
}
stop_old

# ---------------------------------------------------------------- 3. install, build, start
log "npm install"
in_dest "npm install --no-audit --no-fund"
log "npm run build"
in_dest "npm run build"

# the port the app listens on: PORT env, else server/.env, else the default
PORT="${PORT:-$(grep -E '^PORT=' "${DEST_DIR}/server/.env" 2>/dev/null | tail -n1 | cut -d= -f2 | tr -d '"' | tr -d "'" || true)}"
PORT="${PORT:-3417}"

# ---------------------------------------------------------------- map the domain to the app (Caddy reverse proxy + automatic HTTPS)
SECURE=false; BEHIND_PROXY=false
if [ -n "$DOMAIN" ]; then
  if command -v caddy >/dev/null; then
    SITE_DIR="${CADDY_DIR}/sites"; SITE="${SITE_DIR}/amb-board.caddy"; MAIN="${CADDY_DIR}/Caddyfile"
    mkdir -p "$SITE_DIR"
    log "Mapping ${DOMAIN} -> 127.0.0.1:${PORT} in ${SITE}"
    # Caddy keeps the Host header and adds X-Forwarded-*; the app's cross-origin check compares Origin with Host.
    {
      printf '# Managed by deploy.sh: regenerated on every deploy.\n%s {\n    encode gzip\n    request_body {\n        max_size 12MB\n    }\n    reverse_proxy 127.0.0.1:%s\n}\n' "$DOMAIN" "$PORT"
    } > "$SITE"
    # the main Caddyfile must import the sites folder (added once; the original is kept as Caddyfile.bak-deploy)
    IMPORT_LINE="import ${SITE_DIR}/*.caddy"
    if [ ! -f "$MAIN" ]; then
      { [ -n "$ACME_EMAIL" ] && printf '{\n    email %s\n}\n\n' "$ACME_EMAIL"; printf '%s\n' "$IMPORT_LINE"; } > "$MAIN"
    elif ! grep -qF "$IMPORT_LINE" "$MAIN"; then
      cp -n "$MAIN" "${MAIN}.bak-deploy" || true
      printf '\n%s\n' "$IMPORT_LINE" >> "$MAIN"
    fi
    if caddy validate --config "$MAIN" --adapter caddyfile >/dev/null 2>&1; then
      if systemctl is-active --quiet caddy 2>/dev/null; then systemctl reload caddy || warn "could not reload caddy; run: sudo systemctl reload caddy"
      elif systemctl list-unit-files caddy.service >/dev/null 2>&1 && systemctl enable --now caddy 2>/dev/null; then :
      else caddy reload --config "$MAIN" --adapter caddyfile 2>/dev/null || warn "caddy is not running; start it with: sudo systemctl enable --now caddy"; fi
      BEHIND_PROXY=true; SECURE=true   # Caddy serves HTTPS and redirects http to it, so the session cookie is Secure
    else
      caddy validate --config "$MAIN" --adapter caddyfile || true
      warn "the Caddy config is invalid, so ${DOMAIN} is NOT mapped. The app itself is unaffected."
    fi
    if [ -f /etc/nginx/conf.d/amb-board.conf ] || [ -f /etc/nginx/sites-enabled/amb-board.conf ]; then
      warn "an older nginx site for amb-board exists and may hold port 80/443. Remove it and stop nginx: sudo rm -f /etc/nginx/conf.d/amb-board.conf /etc/nginx/sites-enabled/amb-board.conf /etc/nginx/sites-available/amb-board.conf && sudo systemctl disable --now nginx"
    fi
  else
    warn "caddy is not installed, so ${DOMAIN} is not mapped. Install it (sudo pacman -S caddy) and deploy again."
  fi
fi

log "npm start (port ${PORT}, log: ${LOG_FILE})"
: > "$LOG_FILE"
# The server is started through a tiny launcher that writes its OWN pid and then exec's npm. `setsid` makes it the
# leader of a new process group, so the next deploy can stop npm and node together with one signal.
START_SCRIPT="${DEST_DIR}/.start.sh"
{
  printf '#!/usr/bin/env bash\necho $$ > %q\ncd %q\n' "$PID_FILE" "$DEST_DIR"
  # behind Caddy: trust X-Forwarded-For for rate limiting and use the Secure session cookie (the site is HTTPS-only)
  [ "$BEHIND_PROXY" = true ] && printf 'export TRUST_PROXY=true\n'
  [ "$SECURE" = true ] && printf 'export COOKIE_SECURE=true\n'
  printf 'exec npm start\n'
} > "$START_SCRIPT"
chmod +x "$START_SCRIPT"
if [ -n "$RUN_AS" ]; then
  chown "$RUN_AS": "$LOG_FILE" "$START_SCRIPT"
  su - "$RUN_AS" -c "nohup setsid bash '${START_SCRIPT}' >> '${LOG_FILE}' 2>&1 < /dev/null &"
else
  nohup setsid bash "$START_SCRIPT" >> "$LOG_FILE" 2>&1 < /dev/null &
fi
for _ in $(seq 1 20); do [ -s "$PID_FILE" ] && break; sleep 0.25; done
[ -s "$PID_FILE" ] || die "the server did not start (no pid file). See ${LOG_FILE}"

# ---------------------------------------------------------------- verify
log "Waiting for the server to answer on port ${PORT}"
ok=0
for _ in $(seq 1 "$HEALTH_TIMEOUT"); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [ "$ok" -ne 1 ]; then
  warn "the server did not become healthy within ${HEALTH_TIMEOUT} s. Last log lines:"
  tail -n 30 "$LOG_FILE" >&2 || true
  die "deploy of commit ${COMMIT} failed to start. Your data is untouched (backup in ${BACKUP_ROOT})."
fi
log "Deployed commit ${COMMIT} to ${DEST_DIR}; running at http://127.0.0.1:${PORT} (pid $(cat "$PID_FILE"))"
[ "$BEHIND_PROXY" = true ] && log "Public address: https://${DOMAIN} (Caddy fetches the certificate on the first visit; see: sudo journalctl -u caddy -n 30)"
