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
apt-get install -y -qq postfix dovecot-core dovecot-imapd dovecot-lmtpd opendkim opendkim-tools python3 openssl >/dev/null

log "Mailbox storage (user vmail)"
getent group vmail >/dev/null || groupadd -g 5000 vmail
id vmail >/dev/null 2>&1 || useradd -g vmail -u 5000 -d /var/vmail -s /usr/sbin/nologin vmail
install -d -o vmail -g vmail -m 0700 /var/vmail

log "Postfix"
mkdir -p /etc/postfix/amb; for m in vdomains vmailbox valias; do [ -f "/etc/postfix/amb/$m" ] || : > "/etc/postfix/amb/$m"; postmap "/etc/postfix/amb/$m"; done
postconf -e "myhostname = ${MAIL_HOST}" "mydestination = localhost" "inet_interfaces = all" \
  "virtual_mailbox_domains = hash:/etc/postfix/amb/vdomains" "virtual_mailbox_maps = hash:/etc/postfix/amb/vmailbox" \
  "virtual_alias_maps = hash:/etc/postfix/amb/valias" "virtual_transport = lmtp:unix:private/dovecot-lmtp" \
  "smtpd_tls_cert_file = ${CERT}" "smtpd_tls_key_file = ${KEY}" "smtpd_tls_security_level = may" "smtp_tls_security_level = may" \
  "smtpd_sasl_type = dovecot" "smtpd_sasl_path = private/auth" "smtpd_sasl_auth_enable = no" \
  "smtpd_relay_restrictions = permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination" \
  "smtpd_recipient_restrictions = permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination" \
  "smtpd_milters = inet:127.0.0.1:8891" "non_smtpd_milters = inet:127.0.0.1:8891" "milter_default_action = accept" \
  "message_size_limit = 26214400" "anvil_rate_time_unit = 60s" "smtpd_client_message_rate_limit = 100" "smtpd_client_recipient_rate_limit = 300"
# port 587: logins only, encrypted
postconf -M "submission/inet=submission inet n - y - - smtpd"
postconf -P "submission/inet/syslog_name=postfix/submission" "submission/inet/smtpd_tls_security_level=encrypt" "submission/inet/smtpd_sasl_auth_enable=yes" \
  "submission/inet/smtpd_tls_auth_only=yes" "submission/inet/smtpd_relay_restrictions=permit_sasl_authenticated,reject" "submission/inet/milter_macro_daemon_name=ORIGINATING"

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
plugin { quota = maildir:User quota }
service lmtp { unix_listener /var/spool/postfix/private/dovecot-lmtp { mode = 0600
  user = postfix
  group = postfix } }
service auth { unix_listener /var/spool/postfix/private/auth { mode = 0660
  user = postfix
  group = postfix } }
DOVECOT
[ -f /etc/dovecot/amb-users ] || { : > /etc/dovecot/amb-users; chown root:dovecot /etc/dovecot/amb-users; chmod 640 /etc/dovecot/amb-users; }

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
systemctl enable --now amb-mail-sync.path >/dev/null
systemctl enable opendkim dovecot postfix >/dev/null
systemctl restart opendkim dovecot postfix
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then log "Opening ports 25, 587 and 993 in ufw"; ufw allow 25/tcp >/dev/null; ufw allow 587/tcp >/dev/null; ufw allow 993/tcp >/dev/null; fi
postfix check

IP="$(curl -fsS -4 https://ifconfig.me 2>/dev/null || true)"
cat <<DONE

Mail server ready. Now:
  1. Add to ${APP_USER}'s AMB Board server/.env (for example /opt/amb-board3/server/.env), then redeploy:
       MAIL_ENABLED=true
       MAIL_HOST=${MAIL_HOST}
       MAIL_DIR=${MAIL_DIR}
       MAIL_SERVER_IP=${IP:-<this server's public IPv4 address>}
  2. In AMB Board: Settings, Email, attach your domain, add the TXT record it shows, then follow the DNS records list.
  3. Make sure ports 25, 587 and 993 are open at your hosting provider's firewall too, and ask them to set reverse DNS (PTR) for this
     address to ${MAIL_HOST}. Without it much mail you send will be marked as spam.
DONE
