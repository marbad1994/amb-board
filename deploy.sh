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
# Public address: DOMAIN (default amb.makketing.com) is added to the web server that ALREADY owns ports 80/443 (detected
# automatically: nginx or caddy; set PROXY=nginx|caddy|none to force it). No second web server is started. Set DOMAIN= to skip.
#   nginx : writes a server block; for HTTPS give ACME_EMAIL (certbot --nginx) or SSL_CERT and SSL_KEY (e.g. a wildcard cert).
#   caddy : writes a site file and imports it; Caddy gets the certificate itself.
#   other (apache, traefik ...): prints the address to proxy to; nothing is changed.
# If something else (e.g. a Docker proxy) owns port 443, nginx serves the site on port 80 only. When HTTPS is handled in front of
# nginx (Cloudflare, the container on 443) deploy with HTTPS=true so the session cookie is Secure.
# The domain's DNS record must point at this server.
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
SSL_CERT="${SSL_CERT:-}"; SSL_KEY="${SSL_KEY:-}"
HTTPS="${HTTPS:-}"   # true = visitors use https although this server only sees http (Cloudflare, a proxy container in front)
PROXY="${PROXY:-auto}"
CADDY_DIR="${CADDY_DIR:-/etc/caddy}"
NGINX_DIR="${NGINX_DIR:-/etc/nginx}"

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

# ---------------------------------------------------------------- map the domain to the app (through the web server already on 80/443)
SECURE=false; BEHIND_PROXY=false; TLS_ELSEWHERE=""
[ "$HTTPS" = true ] && SECURE=true

# who listens on 80/443 right now? (nginx, caddy, apache2/httpd, traefik, ...)
detect_proxy() {
  local who
  who="$(ss -ltnpH 2>/dev/null | awk '$4 ~ /:(80|443)$/' | grep -o 'users:(("[^"]*"' | head -1 | sed 's/users:(("//; s/"//')"
  case "$who" in
    nginx) echo nginx ;; caddy) echo caddy ;; "") command -v nginx >/dev/null && echo nginx || { command -v caddy >/dev/null && echo caddy || echo none; } ;; *) echo "other:${who}" ;;
  esac
}

# name of the program holding port 443, empty if none
owner_443() { ss -ltnpH 2>/dev/null | awk '$4 ~ /:443$/' | grep -o 'users:(("[^"]*"' | head -1 | sed 's/users:(("//; s/"//'; }

map_nginx() {
  local dir="${NGINX_DIR}/conf.d" conf listen_tls="" o443
  o443="$(owner_443)"
  if [ -n "$o443" ] && [ "$o443" != nginx ]; then
    [ -n "$SSL_CERT$SSL_KEY$ACME_EMAIL" ] && warn "port 443 is held by '${o443}', so nginx cannot terminate HTTPS here; ignoring SSL_CERT/SSL_KEY/ACME_EMAIL and serving ${DOMAIN} on port 80."
    SSL_CERT=""; SSL_KEY=""; ACME_EMAIL=""; TLS_ELSEWHERE="$o443"
  fi
  [ -d "${NGINX_DIR}/sites-available" ] && dir="${NGINX_DIR}/sites-available"
  mkdir -p "$dir"; conf="${dir}/amb-board.conf"
  log "Adding ${DOMAIN} -> 127.0.0.1:${PORT} to nginx (${conf})"
  # Host must reach the app unchanged: its cross-origin check compares the browser's Origin with Host.
  local common="client_max_body_size 12m;
    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }"
  if [ -n "$SSL_CERT" ] && [ -n "$SSL_KEY" ] && [ -f "$SSL_CERT" ] && [ -f "$SSL_KEY" ]; then
    cat > "$conf" <<NGINX
# Managed by deploy.sh: regenerated on every deploy.
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    return 301 https://\$host\$request_uri;
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name ${DOMAIN};
    ssl_certificate ${SSL_CERT};
    ssl_certificate_key ${SSL_KEY};
    ${common}
}
NGINX
    SECURE=true
  else
    cat > "$conf" <<NGINX
# Managed by deploy.sh: regenerated on every deploy. certbot (ACME_EMAIL) adds the HTTPS block next to this one.
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    ${common}
}
NGINX
  fi
  [ "$dir" = "${NGINX_DIR}/sites-available" ] && mkdir -p "${NGINX_DIR}/sites-enabled" && ln -sf "$conf" "${NGINX_DIR}/sites-enabled/amb-board.conf"
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx 2>/dev/null || nginx -s reload || warn "could not reload nginx; run: sudo systemctl reload nginx"
    BEHIND_PROXY=true
    if [ "$SECURE" != true ] && [ -n "$ACME_EMAIL" ]; then
      if command -v certbot >/dev/null; then
        certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$ACME_EMAIL" --redirect && SECURE=true || warn "certbot failed (does the DNS record for ${DOMAIN} point here?); the site stays on plain HTTP"
      else warn "ACME_EMAIL is set but certbot is not installed (sudo pacman -S certbot certbot-nginx)"; fi
    fi
    if [ "$SECURE" != true ]; then
      if [ -n "$TLS_ELSEWHERE" ]; then warn "${DOMAIN} is served over plain HTTP on port 80. If HTTPS is handled in front of nginx (Cloudflare, or the '${TLS_ELSEWHERE}' container on 443), deploy with HTTPS=true; otherwise route https://${DOMAIN} to this nginx from that container."
      else warn "${DOMAIN} is served over plain HTTP. For HTTPS give ACME_EMAIL=... (certbot) or SSL_CERT/SSL_KEY, or HTTPS=true if TLS is handled in front, and deploy again."; fi
    fi
  else
    nginx -t || true
    warn "the generated nginx config is invalid, so ${DOMAIN} is NOT mapped (nginx keeps running with its old config). The app itself is unaffected."
  fi
}

map_caddy() {
  local site_dir="${CADDY_DIR}/sites" site main import_line
  site="${site_dir}/amb-board.caddy"; main="${CADDY_DIR}/Caddyfile"; mkdir -p "$site_dir"
  log "Adding ${DOMAIN} -> 127.0.0.1:${PORT} to Caddy (${site})"
  # Caddy keeps the Host header and adds X-Forwarded-*; the app's cross-origin check compares Origin with Host.
  printf '# Managed by deploy.sh: regenerated on every deploy.\n%s {\n    encode gzip\n    request_body {\n        max_size 12MB\n    }\n    reverse_proxy 127.0.0.1:%s\n}\n' "$DOMAIN" "$PORT" > "$site"
  import_line="import ${site_dir}/*.caddy"
  if [ ! -f "$main" ]; then
    { [ -n "$ACME_EMAIL" ] && printf '{\n    email %s\n}\n\n' "$ACME_EMAIL"; printf '%s\n' "$import_line"; } > "$main"
  elif ! grep -qF "$import_line" "$main"; then
    cp -n "$main" "${main}.bak-deploy" || true
    printf '\n%s\n' "$import_line" >> "$main"
  fi
  if caddy validate --config "$main" --adapter caddyfile >/dev/null 2>&1; then
    if systemctl is-active --quiet caddy 2>/dev/null; then systemctl reload caddy || warn "could not reload caddy; run: sudo systemctl reload caddy"
    else caddy reload --config "$main" --adapter caddyfile 2>/dev/null || warn "caddy is not running; start it with: sudo systemctl enable --now caddy"; fi
    BEHIND_PROXY=true; SECURE=true   # Caddy serves HTTPS and redirects http to it
  else
    caddy validate --config "$main" --adapter caddyfile || true
    warn "the Caddy config is invalid, so ${DOMAIN} is NOT mapped. The app itself is unaffected."
  fi
}

if [ -n "$DOMAIN" ] && [ "$PROXY" != none ]; then
  kind="$PROXY"; [ "$kind" = auto ] && kind="$(detect_proxy)"
  case "$kind" in
    nginx) command -v nginx >/dev/null && map_nginx || warn "nginx was chosen but is not installed, so ${DOMAIN} is not mapped." ;;
    caddy) command -v caddy >/dev/null && map_caddy || warn "caddy was chosen but is not installed, so ${DOMAIN} is not mapped." ;;
    other:*) warn "ports 80/443 are served by '${kind#other:}', which this script does not configure. Add ${DOMAIN} there as a reverse proxy to http://127.0.0.1:${PORT} (keep the Host header). Nothing was changed." ;;
    *) warn "no web server found on ports 80/443 and none is installed, so ${DOMAIN} is not mapped. Install nginx or caddy, or proxy to http://127.0.0.1:${PORT} yourself." ;;
  esac
fi

log "npm start (port ${PORT}, log: ${LOG_FILE})"
: > "$LOG_FILE"
# The server is started through a tiny launcher that writes its OWN pid and then exec's npm. `setsid` makes it the
# leader of a new process group, so the next deploy can stop npm and node together with one signal.
START_SCRIPT="${DEST_DIR}/.start.sh"
{
  printf '#!/usr/bin/env bash\necho $$ > %q\ncd %q\n' "$PID_FILE" "$DEST_DIR"
  # behind a proxy: trust X-Forwarded-For for rate limiting; over HTTPS: Secure session cookie (it would break plain-HTTP logins)
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
[ "$BEHIND_PROXY" = true ] && log "Public address: $([ "$SECURE" = true ] && echo https || echo http)://${DOMAIN}"
