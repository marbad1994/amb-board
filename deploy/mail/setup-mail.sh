#!/usr/bin/env bash
# One-time mail server setup for AMB Board email hosting (Debian or Ubuntu). Installs Postfix, Dovecot and OpenDKIM, wires them to the
# files AMB Board writes, and installs the root helper that applies them. Safe to run again.
#
#   sudo MAIL_HOST=mail.makketing.com APP_USER=marcus bash deploy/mail/setup-mail.sh
#
# Before you run it:
#   - DNS: an A record for MAIL_HOST pointing at this server (and ask your provider to set the reverse DNS/PTR to the same name).
#   - A certificate for MAIL_HOST. With Caddy (a host service or a Docker container) the script asks Caddy for it: it adds a site for MAIL_HOST,
#     waits for the certificate and uses it. With nginx run certbot first:  certbot certonly --nginx -d mail.makketing.com
#     Or give your own files: CERT=/path/fullchain.pem KEY=/path/privkey.pem
#   - Your provider must allow mail ports (many block outgoing port 25: ask them, or mail will not leave this server).
# Nothing here changes DNS. Mail for a domain only arrives once you point that domain's MX record at MAIL_HOST.
set -euo pipefail

MAIL_HOST="${MAIL_HOST:-}"
APP_USER="${APP_USER:-${SUDO_USER:-}}"          # the user the AMB Board server runs as (it writes MAIL_DIR/in)
MAIL_DIR="${MAIL_DIR:-/var/lib/amb-mail}"
CERT="${CERT:-/etc/letsencrypt/live/${MAIL_HOST}/fullchain.pem}"
KEY="${KEY:-/etc/letsencrypt/live/${MAIL_HOST}/privkey.pem}"
INSTALL_WEBMAIL="${INSTALL_WEBMAIL:-auto}"   # yes | no | auto (yes when nginx is installed)
HERE="$(cd "$(dirname "$0")" && pwd)"

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
[ -n "$MAIL_HOST" ] || die "set MAIL_HOST, the name of this mail server (for example mail.makketing.com)"
[ -n "$APP_USER" ] && id "$APP_USER" >/dev/null 2>&1 || die "set APP_USER to the user AMB Board runs as"
command -v apt-get >/dev/null || die "this script supports Debian and Ubuntu (apt)"
getent hosts "$MAIL_HOST" >/dev/null || warn "$MAIL_HOST does not resolve yet; create its A record (Caddy cannot get a certificate without it)"

# ---------------------------------------------------------------- which web server owns 443, and the certificate
CADDY_DIR="${CADDY_DIR:-/etc/caddy}"
owner_443() { ss -ltnpH 2>/dev/null | awk '$4 ~ /:443$/' | grep -o 'users:(("[^"]*"' | head -1 | sed 's/users:(("//; s/"//'; }
caddy_container() {
  command -v docker >/dev/null || return 1
  local n="${CADDY_CONTAINER:-}"
  [ -n "$n" ] || n="$(docker ps --format '{{.Names}} {{.Image}} {{.Ports}}' 2>/dev/null | awk '/caddy/ && /:443->443/ {print $1; exit}')"
  [ -n "$n" ] && printf '%s' "$n"
}
detect_web() {
  case "$(owner_443)" in nginx) echo nginx; return ;; caddy) echo caddy-host; return ;; esac
  if caddy_container >/dev/null 2>&1; then echo caddy-docker; return; fi
  command -v nginx >/dev/null && { echo nginx; return; }
  command -v caddy >/dev/null && { echo caddy-host; return; }
  echo none
}
WEB="$(detect_web)"; CERT_FROM_CADDY=0; CADDY_NAME=""; CADDY_CFG=""; CADDY_HOSTFILE=""; CADDY_DATA=""

# a Caddy container: its Caddyfile as seen from this server, and its data volume (where the certificates are)
docker_caddy_paths() {
  CADDY_NAME="$(caddy_container)"
  CADDY_CFG="$(docker inspect -f '{{join .Config.Cmd " "}}' "$CADDY_NAME" 2>/dev/null | grep -o -- '--config [^ ]*' | head -1 | cut -d' ' -f2)"; CADDY_CFG="${CADDY_CFG:-/etc/caddy/Caddyfile}"
  local src dst rw
  while read -r src dst rw; do
    [ -n "$dst" ] || continue
    if [ "$dst" = "$CADDY_CFG" ]; then CADDY_HOSTFILE="$src"; fi
    case "$CADDY_CFG" in "$dst"/*) [ -n "$CADDY_HOSTFILE" ] || CADDY_HOSTFILE="${src}${CADDY_CFG#"$dst"}" ;; esac
    [ "$dst" = /data ] && CADDY_DATA="$src"
  done < <(docker inspect -f '{{range .Mounts}}{{.Source}} {{.Destination}} {{.RW}}{{"\n"}}{{end}}' "$CADDY_NAME" 2>/dev/null)
  [ -f "$CADDY_HOSTFILE" ] || die "found the Caddy container '${CADDY_NAME}' but not its Caddyfile on this server (looked for ${CADDY_CFG}). Give your own certificate: CERT=... KEY=..."
}

# Writes or replaces the block for MAIL_HOST in Caddy ($1 = the lines inside the site block) and reloads Caddy.
caddy_apply() {
  local body="$1" block
  block="$(printf '# BEGIN amb-mail (setup-mail.sh)\n%s {\n%s\n}\n# END amb-mail (setup-mail.sh)\n' "$MAIL_HOST" "$body")"
  if [ "$WEB" = caddy-host ]; then
    local site_dir="${CADDY_DIR}/sites" main="${CADDY_DIR}/Caddyfile" import_line
    mkdir -p "$site_dir"; printf '%s\n' "$block" > "${site_dir}/amb-mail.caddy"
    import_line="import ${site_dir}/*.caddy"
    if [ ! -f "$main" ]; then printf '%s\n' "$import_line" > "$main"
    elif ! grep -qF "$import_line" "$main"; then cp -n "$main" "${main}.bak-amb-mail" || true; printf '\n%s\n' "$import_line" >> "$main"; fi
    caddy validate --config "$main" --adapter caddyfile >/dev/null 2>&1 || { caddy validate --config "$main" --adapter caddyfile 2>&1 | tail -3; return 1; }
    if systemctl is-active --quiet caddy 2>/dev/null; then systemctl reload caddy; else caddy reload --config "$main" --adapter caddyfile; fi
  else
    local bak tmp; bak="${CADDY_HOSTFILE}.bak-amb-mail-$(date +%Y%m%d-%H%M%S)"; cp -p "$CADDY_HOSTFILE" "$bak"; tmp="$(mktemp)"
    awk '/^# BEGIN amb-mail \(setup-mail.sh\)/ {skip=1} !skip {print} /^# END amb-mail \(setup-mail.sh\)/ {skip=0}' "$CADDY_HOSTFILE" > "$tmp"
    printf '\n%s\n' "$block" >> "$tmp"
    cat "$tmp" > "$CADDY_HOSTFILE"; rm -f "$tmp"   # in place: a single-file bind mount keeps pointing at the same file
    if docker exec "$CADDY_NAME" caddy validate --config "$CADDY_CFG" --adapter caddyfile >/dev/null 2>&1 && docker exec "$CADDY_NAME" caddy reload --config "$CADDY_CFG" --adapter caddyfile >/dev/null 2>&1; then return 0; fi
    docker exec "$CADDY_NAME" caddy validate --config "$CADDY_CFG" --adapter caddyfile 2>&1 | tail -3 || true
    cat "$bak" > "$CADDY_HOSTFILE"; warn "Caddy rejected the block, the original Caddyfile was restored (backup: ${bak})"; return 1
  fi
}

# Looks for the certificate Caddy holds for MAIL_HOST in its storage and sets CERT and KEY.
find_caddy_cert() {
  local roots=() r crt
  if [ "$WEB" = caddy-docker ]; then [ -n "$CADDY_DATA" ] && roots+=("$CADDY_DATA/caddy")
  else roots+=(/var/lib/caddy/.local/share/caddy /root/.local/share/caddy /home/*/.local/share/caddy); [ -n "${XDG_DATA_HOME:-}" ] && roots+=("$XDG_DATA_HOME/caddy"); fi
  for r in "${roots[@]}"; do
    [ -d "$r/certificates" ] || continue
    crt="$(find "$r/certificates" -type f -name "${MAIL_HOST}.crt" -print -quit 2>/dev/null)"
    if [ -n "$crt" ] && [ -r "${crt%.crt}.key" ]; then CERT="$crt"; KEY="${crt%.crt}.key"; return 0; fi
  done
  return 1
}

get_caddy_cert() {
  case "$WEB" in caddy-host|caddy-docker) ;; *) return 1 ;; esac
  [ "$WEB" = caddy-docker ] && docker_caddy_paths
  if find_caddy_cert; then log "Using the certificate Caddy already holds for ${MAIL_HOST}"; CERT_FROM_CADDY=1; return 0; fi
  log "Asking Caddy for a certificate for ${MAIL_HOST} (the A record must point here and ports 80 and 443 must reach Caddy; up to 2.5 minutes)"
  caddy_apply '    respond "Mail server" 200' || return 1
  local i; for i in $(seq 1 30); do if find_caddy_cert; then CERT_FROM_CADDY=1; return 0; fi; sleep 5; done
  return 1
}

if [ -r "$CERT" ] && [ -r "$KEY" ]; then log "Using the certificate ${CERT}"
elif ! get_caddy_cert; then
  die "no certificate for ${MAIL_HOST}. With nginx: certbot certonly --nginx -d ${MAIL_HOST}. With Caddy: check that the A record points at this server and that Caddy can reach the internet on 80 and 443 (see its log), or give your own files: CERT=/path/fullchain.pem KEY=/path/privkey.pem"
fi
log "Web server: ${WEB}; certificate: ${CERT}"

log "Installing Postfix, Dovecot and OpenDKIM"
export DEBIAN_FRONTEND=noninteractive
echo "postfix postfix/mailname string ${MAIL_HOST}"      | debconf-set-selections
echo "postfix postfix/main_mailer_type string Internet Site" | debconf-set-selections
apt-get update -qq
apt-get install -y -qq postfix dovecot-core dovecot-imapd dovecot-lmtpd dovecot-sieve opendkim opendkim-tools rspamd redis-server python3 openssl >/dev/null

log "Mailbox storage (user vmail)"
getent group vmail >/dev/null || groupadd -g 5000 vmail
id vmail >/dev/null 2>&1 || useradd -g vmail -u 5000 -d /var/vmail -s /usr/sbin/nologin vmail
install -d -o vmail -g vmail -m 0700 /var/vmail

log "Postfix"
mkdir -p /etc/postfix/amb; for m in vdomains vmailbox valias sender_login; do [ -f "/etc/postfix/amb/$m" ] || : > "/etc/postfix/amb/$m"; postmap "/etc/postfix/amb/$m"; done
postconf -e "myhostname = ${MAIL_HOST}" "mydestination = localhost" "inet_interfaces = all" \
  "virtual_mailbox_domains = hash:/etc/postfix/amb/vdomains" "virtual_mailbox_maps = hash:/etc/postfix/amb/vmailbox" \
  "virtual_alias_maps = hash:/etc/postfix/amb/valias" "virtual_transport = lmtp:unix:private/dovecot-lmtp" \
  "smtpd_tls_cert_file = ${CERT}" "smtpd_tls_key_file = ${KEY}" "smtpd_tls_security_level = may" "smtp_tls_security_level = may" \
  "smtpd_sasl_type = dovecot" "smtpd_sasl_path = private/auth" "smtpd_sasl_auth_enable = no" \
  "smtpd_relay_restrictions = permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination" \
  "smtpd_recipient_restrictions = permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination" \
  "smtpd_milters = inet:127.0.0.1:11332, inet:127.0.0.1:8891" "non_smtpd_milters = inet:127.0.0.1:8891" "milter_default_action = accept" \
  "milter_mail_macros = i {mail_addr} {client_addr} {client_name} {auth_authen}" \
  "message_size_limit = 26214400" "anvil_rate_time_unit = 60s" "smtpd_client_message_rate_limit = 100" "smtpd_client_recipient_rate_limit = 300"
# port 587: logins only, encrypted
postconf -M "submission/inet=submission inet n - y - - smtpd"
postconf -P "submission/inet/syslog_name=postfix/submission" "submission/inet/smtpd_tls_security_level=encrypt" "submission/inet/smtpd_sasl_auth_enable=yes" \
  "submission/inet/smtpd_tls_auth_only=yes" "submission/inet/smtpd_relay_restrictions=permit_sasl_authenticated,reject" "submission/inet/milter_macro_daemon_name=ORIGINATING" \
  "submission/inet/smtpd_milters=inet:127.0.0.1:8891" \
  "submission/inet/smtpd_sender_login_maps=hash:/etc/postfix/amb/sender_login" \
  "submission/inet/smtpd_sender_restrictions=reject_sender_login_mismatch,permit_sasl_authenticated"
# postconf -P refuses values with spaces, and "check_policy_service unix:..." needs one: keep the list in a main.cf parameter and refer to it
postconf -e "amb_submission_recipient_restrictions = check_policy_service unix:private/amb-policy, permit_sasl_authenticated, reject"
postconf -P 'submission/inet/smtpd_recipient_restrictions=$amb_submission_recipient_restrictions'

log "Dovecot"
# A single global key for Dovecot mail_crypt, so per-mailbox encryption (turned on in AMB Board) works out of the box.
[ -f /etc/dovecot/amb-mail-crypt.key ] || { openssl genrsa -out /etc/dovecot/amb-mail-crypt.key 2048 >/dev/null 2>&1; chown root:dovecot /etc/dovecot/amb-mail-crypt.key; chmod 640 /etc/dovecot/amb-mail-crypt.key; }
[ -f /etc/dovecot/amb-mail-crypt.pub ] || { openssl rsa -in /etc/dovecot/amb-mail-crypt.key -pubout -out /etc/dovecot/amb-mail-crypt.pub >/dev/null 2>&1; chown root:dovecot /etc/dovecot/amb-mail-crypt.pub; chmod 640 /etc/dovecot/amb-mail-crypt.pub; }
sed -i 's/^\s*!include auth-system.conf.ext/#&/' /etc/dovecot/conf.d/10-auth.conf   # no logins for system users
cat > /etc/dovecot/conf.d/99-amb.conf <<DOVECOT
protocols = imap lmtp
mail_location = maildir:/var/vmail/%d/%n
mail_uid = vmail
mail_gid = vmail
first_valid_uid = 5000
disable_plaintext_auth = yes
auth_mechanisms = plain login
ssl = required
ssl_cert = <${CERT}
ssl_key = <${KEY}
passdb {
  driver = passwd-file
  args = username_format=%u /etc/dovecot/amb-users
}
userdb {
  driver = passwd-file
  args = username_format=%u /etc/dovecot/amb-users
  default_fields = uid=vmail gid=vmail home=/var/vmail/%d/%n
}
mail_plugins = \$mail_plugins quota
protocol imap {
  mail_plugins = \$mail_plugins imap_quota
}
protocol lmtp {
  mail_plugins = \$mail_plugins sieve
}
plugin {
  quota = maildir:User quota
  sieve_before = /etc/dovecot/sieve-before.d/
  mail_crypt_global_private_key = </etc/dovecot/amb-mail-crypt.key
  mail_crypt_global_public_key = </etc/dovecot/amb-mail-crypt.pub
}
service lmtp {
  unix_listener /var/spool/postfix/private/dovecot-lmtp {
    mode = 0600
    user = postfix
    group = postfix
  }
}
service auth {
  unix_listener /var/spool/postfix/private/auth {
    mode = 0660
    user = postfix
    group = postfix
  }
}
DOVECOT
# the standard folders exist and are subscribed, so Junk is there for filed spam and for the mail apps
for box in Drafts Junk Trash Sent; do sed -i "/mailbox $box {/,/}/ { /auto = /d; s/mailbox $box {/mailbox $box {\n    auto = subscribe/ }" /etc/dovecot/conf.d/15-mailboxes.conf; done
install -d /etc/dovecot/sieve-before.d
printf 'require ["fileinto"];\nif header :contains "X-Spam-Status" "Yes" {\n  fileinto "Junk";\n  stop;\n}\n' > /etc/dovecot/sieve-before.d/10-amb-spam.sieve
sievec /etc/dovecot/sieve-before.d/10-amb-spam.sieve
[ -f /etc/dovecot/amb-users ] || { : > /etc/dovecot/amb-users; chown root:dovecot /etc/dovecot/amb-users; chmod 640 /etc/dovecot/amb-users; }

log "Spam filter (Rspamd)"
install -d /etc/rspamd/local.d
cat > /etc/rspamd/local.d/worker-proxy.inc <<RSPAMD
milter = yes;
timeout = 120s;
bind_socket = "127.0.0.1:11332";
upstream "local" { default = yes; self_scan = yes; }
RSPAMD
printf 'reject = 15;\nadd_header = 6;\ngreylist = 1000;\n' > /etc/rspamd/local.d/actions.conf
printf 'use = ["x-spam-status", "x-spam-level", "authentication-results"];\nauthenticated_headers = ["authentication-results"];\n' > /etc/rspamd/local.d/milter_headers.conf
printf 'servers = "127.0.0.1";\n' > /etc/rspamd/local.d/redis.conf
printf 'autolearn = true;\n' > /etc/rspamd/local.d/classifier-bayes.conf

log "OpenDKIM"
[ -f /etc/opendkim.conf.amb-backup ] || cp /etc/opendkim.conf /etc/opendkim.conf.amb-backup 2>/dev/null || true
install -d -o opendkim -g opendkim -m 0750 /etc/opendkim /etc/opendkim/keys
for f in KeyTable SigningTable; do [ -f "/etc/opendkim/$f" ] || : > "/etc/opendkim/$f"; done
printf '127.0.0.1\nlocalhost\n' > /etc/opendkim/TrustedHosts
cat > /etc/opendkim.conf <<DKIM
Syslog yes
UMask 007
Mode sv
Canonicalization relaxed/simple
OversignHeaders From
Socket inet:8891@127.0.0.1
PidFile /run/opendkim/opendkim.pid
UserID opendkim
KeyTable refile:/etc/opendkim/KeyTable
SigningTable refile:/etc/opendkim/SigningTable
InternalHosts refile:/etc/opendkim/TrustedHosts
ExternalIgnoreList refile:/etc/opendkim/TrustedHosts
DKIM

log "The helper that applies what AMB Board writes"
install -d -o "$APP_USER" -m 0750 "$MAIL_DIR" "$MAIL_DIR/in" "$MAIL_DIR/in/dkim"
install -d -o root -m 0755 "$MAIL_DIR/out"
install -m 0755 "$HERE/amb-mail-sync" /usr/local/sbin/amb-mail-sync
install -m 0755 "$HERE/amb-mail-policy" /usr/local/sbin/amb-mail-policy
install -m 0755 "$HERE/amb-mail-notify" /usr/local/sbin/amb-mail-notify
install -d -m 0755 /etc/amb-mail
ln -sfn /var/lib/amb-mail-policy/usage.json "$MAIL_DIR/out/usage.json"      # AMB Board shows how much each mailbox sent
# new-mail reports to AMB Board: the shared secret is created once and kept; AMB_URL is where AMB Board listens on this server
NOTIFY_CONF=/etc/amb-mail/notify.conf
if [ -f "$NOTIFY_CONF" ]; then NOTIFY_SECRET="$(python3 -c 'import json; print(json.load(open("/etc/amb-mail/notify.conf"))["secret"])')"; else NOTIFY_SECRET="$(openssl rand -hex 24)"; fi
printf '{"url": "%s", "secret": "%s"}\n' "${AMB_URL:-http://127.0.0.1:${AMB_PORT:-3417}}/api/mail-notify" "$NOTIFY_SECRET" > "$NOTIFY_CONF"
chown root:vmail "$NOTIFY_CONF"; chmod 640 "$NOTIFY_CONF"
cat > /etc/systemd/system/amb-mail-notify.service <<UNIT
[Unit]
Description=Tell AMB Board about new mail
After=network.target dovecot.service
[Service]
User=vmail
StateDirectory=amb-mail-notify
ExecStart=/usr/local/sbin/amb-mail-notify
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/amb-mail-policy.service <<UNIT
[Unit]
Description=Sending limits per mailbox and domain for AMB Board email hosting
After=network.target
Before=postfix.service
[Service]
User=postfix
StateDirectory=amb-mail-policy
ExecStart=/usr/local/sbin/amb-mail-policy
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/amb-mail-sync.service <<UNIT
[Unit]
Description=Apply AMB Board mail settings to Postfix, Dovecot and OpenDKIM
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/amb-mail-sync --dir ${MAIL_DIR}
UNIT
cat > /etc/systemd/system/amb-mail-sync.path <<UNIT
[Unit]
Description=Watch for AMB Board mail changes
[Path]
PathChanged=${MAIL_DIR}/in/sync-request
Unit=amb-mail-sync.service
[Install]
WantedBy=multi-user.target
UNIT
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nsystemctl reload postfix dovecot\n' > /etc/letsencrypt/renewal-hooks/deploy/amb-mail.sh; chmod 755 /etc/letsencrypt/renewal-hooks/deploy/amb-mail.sh
systemctl daemon-reload
systemctl enable --now amb-mail-sync.path amb-mail-policy.service amb-mail-notify.service >/dev/null
systemctl enable opendkim dovecot postfix rspamd redis-server >/dev/null
# check before starting, so a mistake is reported with its file and line instead of "the service failed"
doveconf -n >/dev/null || die "Dovecot rejected its configuration (the message above names the file and line)"
postfix check || die "Postfix rejected its configuration (see above)"
for svc in redis-server rspamd opendkim dovecot postfix; do
  systemctl restart "$svc" || { systemctl status "$svc" --no-pager -n 20 || true; journalctl -u "$svc" --no-pager -n 15 || true; die "$svc failed to start (see above)"; }
done
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then log "Opening ports 25, 587 and 993 in ufw"; ufw allow 25/tcp >/dev/null; ufw allow 587/tcp >/dev/null; ufw allow 993/tcp >/dev/null; fi
postfix check

# ---- webmail (Roundcube behind the web server that already owns ports 80 and 443)
WEBMAIL_URL=""
# Caddy in a container cannot run PHP, so Roundcube runs as its own container next to it and Caddy proxies to that.
webmail_docker() {
  command -v docker >/dev/null || return 1
  [ -n "$CADDY_NAME" ] || docker_caddy_paths
  local net="" n gw="" port="${WEBMAIL_PORT:-8083}" upstream args=()
  for n in $(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$CADDY_NAME" 2>/dev/null); do net="$n"; [ "$n" != bridge ] && break; done
  gw="$(docker inspect -f "{{(index .NetworkSettings.Networks \"${net}\").Gateway}}" "$CADDY_NAME" 2>/dev/null)"
  [ -n "$net" ] && [ -n "$gw" ] || { warn "could not read the network of the Caddy container '${CADDY_NAME}'"; return 1; }
  log "Webmail: Roundcube container, on the network of '${CADDY_NAME}' (${net})"
  docker rm -f amb-roundcube >/dev/null 2>&1 || true
  docker volume create amb-roundcube-db >/dev/null
  # the container reaches this server's mail ports through the Docker gateway under the mail host name, so the certificate matches
  args=(run -d --name amb-roundcube --restart unless-stopped --network "$net" --add-host "${MAIL_HOST}:${gw}" -v amb-roundcube-db:/var/roundcube/db
    -e ROUNDCUBEMAIL_DB_TYPE=sqlite -e "ROUNDCUBEMAIL_DEFAULT_HOST=ssl://${MAIL_HOST}" -e ROUNDCUBEMAIL_DEFAULT_PORT=993
    -e "ROUNDCUBEMAIL_SMTP_SERVER=tls://${MAIL_HOST}" -e ROUNDCUBEMAIL_SMTP_PORT=587 -e ROUNDCUBEMAIL_UPLOAD_MAX_FILESIZE=30M
    -e ROUNDCUBEMAIL_SKIN=elastic)
  if [ "$net" = bridge ]; then args+=(-p "${gw}:${port}:80"); upstream="${gw}:${port}"; else upstream="amb-roundcube:80"; fi   # the default bridge has no names
  docker "${args[@]}" "roundcube/roundcubemail:latest" >/dev/null || { warn "could not start the Roundcube container (is the image reachable? docker pull roundcube/roundcubemail)"; return 1; }
  caddy_apply "    encode gzip
    request_body {
        max_size 30MB
    }
    reverse_proxy ${upstream}" || return 1
  WEBMAIL_URL="https://${MAIL_HOST}/"
}

if [ "$INSTALL_WEBMAIL" = auto ]; then case "$WEB" in nginx|caddy-host|caddy-docker) INSTALL_WEBMAIL=yes ;; *) INSTALL_WEBMAIL=no ;; esac; fi
if [ "$INSTALL_WEBMAIL" = yes ] && [ "$WEB" = caddy-docker ]; then
  webmail_docker || warn "webmail was not installed (see above). Mail apps still work. The certificate site stays in place."
  INSTALL_WEBMAIL=done
fi
if [ "$INSTALL_WEBMAIL" = yes ] && [ "$WEB" = none ]; then warn "no nginx or Caddy found, so webmail was not installed; serve /usr/share/roundcube with PHP-FPM yourself"; INSTALL_WEBMAIL=no; fi
if [ "$INSTALL_WEBMAIL" = yes ]; then
  log "Webmail (Roundcube)"
  echo "roundcube-core roundcube/dbconfig-install boolean true" | debconf-set-selections
  echo "roundcube-core roundcube/database-type select sqlite3" | debconf-set-selections
  apt-get install -y -qq --no-install-recommends roundcube-core roundcube-sqlite3 php-fpm >/dev/null
  CONF=/etc/roundcube/config.inc.php
  sed -i '/BEGIN amb-mail/,/END amb-mail/d' "$CONF"
  cat >> "$CONF" <<RC
// BEGIN amb-mail
\$config['imap_host'] = 'ssl://${MAIL_HOST}:993';
\$config['smtp_host'] = 'tls://${MAIL_HOST}:587';
\$config['smtp_user'] = '%u';
\$config['smtp_pass'] = '%p';
\$config['product_name'] = 'Webmail';
// END amb-mail
RC
  SOCK="$(ls /run/php/php*-fpm.sock 2>/dev/null | head -1 || true)"
  [ -n "$SOCK" ] || die "PHP-FPM socket not found under /run/php"
  if [ "$WEB" = nginx ]; then
    cat > /etc/nginx/conf.d/amb-webmail.conf <<'NGINX'
server {
  listen 80;
  server_name @HOST@;
  location /.well-known/acme-challenge/ { root /var/www/html; }
  location / { return 301 https://$host$request_uri; }
}
server {
  listen 443 ssl;
  server_name @HOST@;
  ssl_certificate @CERT@;
  ssl_certificate_key @KEY@;
  root /usr/share/roundcube;
  index index.php;
  client_max_body_size 30m;
  add_header X-Frame-Options SAMEORIGIN always;
  add_header X-Content-Type-Options nosniff always;
  add_header Referrer-Policy same-origin always;
  location ~ ^/(config|temp|logs|SQL|bin|vendor)(/|$) { deny all; }
  location ~ /\. { deny all; }
  location ~ \.php$ { include snippets/fastcgi-php.conf; fastcgi_pass unix:@SOCK@; }
  location / { try_files $uri $uri/ =404; }
}
NGINX
    sed -i "s#@HOST@#${MAIL_HOST}#g; s#@CERT@#${CERT}#g; s#@KEY@#${KEY}#g; s#@SOCK@#${SOCK}#g" /etc/nginx/conf.d/amb-webmail.conf
    if nginx -t >/dev/null 2>&1; then systemctl reload nginx; WEBMAIL_URL="https://${MAIL_HOST}/"
    else rm -f /etc/nginx/conf.d/amb-webmail.conf; warn "nginx rejected the webmail site (nginx -t); webmail was not enabled. Is conf.d included in nginx.conf?"; fi
  else
    # Caddy on this host: it serves Roundcube through PHP-FPM; the PHP socket must be reachable for the user Caddy runs as
    CUSER="$(ps -o user= -C caddy 2>/dev/null | head -1 | tr -d ' ')"; CUSER="${CUSER:-caddy}"
    for pool in /etc/php/*/fpm/pool.d/www.conf; do
      [ -f "$pool" ] || continue
      sed -i "s/^;\?listen.group = .*/listen.group = ${CUSER}/; s/^;\?listen.mode = .*/listen.mode = 0660/" "$pool"
    done
    systemctl reload php*-fpm 2>/dev/null || systemctl restart php*-fpm
    if caddy_apply "    root * /usr/share/roundcube
    encode gzip
    request_body {
        max_size 30MB
    }
    header {
        X-Frame-Options SAMEORIGIN
        X-Content-Type-Options nosniff
        Referrer-Policy same-origin
    }
    @private path /config/* /temp/* /logs/* /SQL/* /bin/* /vendor/*
    respond @private 403
    php_fastcgi unix/${SOCK}
    file_server"; then WEBMAIL_URL="https://${MAIL_HOST}/"
    else warn "Caddy rejected the webmail site; webmail was not enabled (the certificate site is still in place)"; fi
  fi
fi

# Caddy renews its certificate in place; Postfix and Dovecot read it again when reloaded
if [ "$CERT_FROM_CADDY" = 1 ]; then
  printf '[Unit]\nDescription=Reload mail services to pick up the renewed certificate\n[Service]\nType=oneshot\nExecStart=/bin/systemctl reload postfix dovecot\n' > /etc/systemd/system/amb-mail-cert.service
  printf '[Unit]\nDescription=Weekly reload of mail services (certificate renewal)\n[Timer]\nOnCalendar=weekly\nPersistent=true\n[Install]\nWantedBy=timers.target\n' > /etc/systemd/system/amb-mail-cert.timer
  systemctl daemon-reload; systemctl enable --now amb-mail-cert.timer >/dev/null
fi

IP="$(curl -fsS -4 https://ifconfig.me 2>/dev/null || true)"; SHOW_IP="${IP:-YOUR_SERVER_PUBLIC_IPV4}"
SHOW_WEBMAIL=""; [ -n "$WEBMAIL_URL" ] && SHOW_WEBMAIL="       MAIL_WEBMAIL_URL=${WEBMAIL_URL}"
cat <<DONE

Mail server ready. Now:
  1. Add to ${APP_USER}'s AMB Board server/.env (for example /opt/amb-board3/server/.env), then redeploy:
       MAIL_ENABLED=true
       MAIL_HOST=${MAIL_HOST}
       MAIL_DIR=${MAIL_DIR}
       MAIL_SERVER_IP=${SHOW_IP}
       MAIL_NOTIFY_SECRET=${NOTIFY_SECRET}
${SHOW_WEBMAIL}
  2. In AMB Board: Settings, Email, attach your domain, add the TXT record it shows, then follow the DNS records list.
  3. Make sure ports 25, 587 and 993 are open at your hosting provider's firewall too, and ask them to set reverse DNS (PTR) for this
     address to ${MAIL_HOST}. Without it much mail you send will be marked as spam.
DONE
