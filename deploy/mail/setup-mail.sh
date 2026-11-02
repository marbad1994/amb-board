#!/usr/bin/env bash
# One-time mail server setup for AMB Board email hosting (Debian or Ubuntu). Installs Postfix, Dovecot and OpenDKIM, wires them to the
# files AMB Board writes, and installs the root helper that applies them. Safe to run again.
#
#   sudo MAIL_HOST=mail.makketing.com APP_USER=marcus bash deploy/mail/setup-mail.sh
#
# Before you run it:
#   - DNS: an A record for MAIL_HOST pointing at this server (and ask your provider to set the reverse DNS/PTR to the same name).
#   - A certificate for MAIL_HOST:  certbot certonly --nginx -d mail.makketing.com   (or --webroot). Set CERT/KEY to use another.
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
[ -r "$CERT" ] && [ -r "$KEY" ] || die "no certificate at $CERT. Get one first: certbot certonly --nginx -d ${MAIL_HOST}"
getent hosts "$MAIL_HOST" >/dev/null || warn "$MAIL_HOST does not resolve yet; create its A record"

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
  "submission/inet/smtpd_sender_restrictions=reject_sender_login_mismatch,permit_sasl_authenticated" \
  "submission/inet/smtpd_recipient_restrictions=check_policy_service unix:private/amb-policy,permit_sasl_authenticated,reject"

log "Dovecot"
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
protocol imap { mail_plugins = \$mail_plugins imap_quota }
protocol lmtp { mail_plugins = \$mail_plugins sieve }
plugin {
  quota = maildir:User quota
  sieve_before = /etc/dovecot/sieve-before.d/
}
service lmtp { unix_listener /var/spool/postfix/private/dovecot-lmtp { mode = 0600
  user = postfix
  group = postfix } }
service auth { unix_listener /var/spool/postfix/private/auth { mode = 0660
  user = postfix
  group = postfix } }
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
install -d -m 0755 /etc/amb-mail
ln -sfn /var/lib/amb-mail-policy/usage.json "$MAIL_DIR/out/usage.json"      # AMB Board shows how much each mailbox sent
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
systemctl enable --now amb-mail-sync.path amb-mail-policy.service >/dev/null
systemctl enable opendkim dovecot postfix rspamd redis-server >/dev/null
systemctl restart redis-server rspamd opendkim dovecot postfix
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then log "Opening ports 25, 587 and 993 in ufw"; ufw allow 25/tcp >/dev/null; ufw allow 587/tcp >/dev/null; ufw allow 993/tcp >/dev/null; fi
postfix check

# ---- webmail (Roundcube behind the web server that already owns ports 80 and 443)
WEBMAIL_URL=""
if [ "$INSTALL_WEBMAIL" = auto ]; then command -v nginx >/dev/null && INSTALL_WEBMAIL=yes || INSTALL_WEBMAIL=no; fi
if [ "$INSTALL_WEBMAIL" = yes ]; then
  if ! command -v nginx >/dev/null; then
    warn "webmail needs nginx here; install it, or serve /usr/share/roundcube with your web server yourself (PHP-FPM)"
  else
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
  fi
fi

IP="$(curl -fsS -4 https://ifconfig.me 2>/dev/null || true)"
cat <<DONE

Mail server ready. Now:
  1. Add to ${APP_USER}'s AMB Board server/.env (for example /opt/amb-board3/server/.env), then redeploy:
       MAIL_ENABLED=true
       MAIL_HOST=${MAIL_HOST}
       MAIL_DIR=${MAIL_DIR}
       MAIL_SERVER_IP=${IP:-<this server's public IPv4 address>}
$( [ -n "$WEBMAIL_URL" ] && printf '       MAIL_WEBMAIL_URL=%s' "$WEBMAIL_URL" )
  2. In AMB Board: Settings, Email, attach your domain, add the TXT record it shows, then follow the DNS records list.
  3. Make sure ports 25, 587 and 993 are open at your hosting provider's firewall too, and ask them to set reverse DNS (PTR) for this
     address to ${MAIL_HOST}. Without it much mail you send will be marked as spam.
DONE
