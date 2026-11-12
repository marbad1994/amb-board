#!/usr/bin/env bash
# Installs push-notes on this server: every minute it checks the git checkout of a project and, when its code has changed, emails the
# tester a plain-language "what to test" summary (written by Claude from the commits and the diff). Safe to run again.
#
#   sudo REPO_DIR=/home/marcus/makketing TEST_NOTES_TO=addaaaa.r@gmail.com bash deploy/push-notes/install.sh
#
# Optional: GIT_USER (the user who owns the checkout, default the user who ran sudo), BRANCH (main), FETCH=true (email when the code is
# PUSHED to GitHub instead of when it reaches this server), APP_ENV (AMB Board's .env, whose SMTP settings are reused).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GIT_USER="${GIT_USER:-${SUDO_USER:-}}"
REPO_DIR="${REPO_DIR:-}"
DEST="${DEST:-/opt/push-notes}"
CONF="${CONF:-/etc/push-notes.env}"
APP_ENV="${APP_ENV:-/opt/amb-board3/server/.env}"

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
[ -n "$GIT_USER" ] && id "$GIT_USER" >/dev/null 2>&1 || die "set GIT_USER to the user who owns the checkout"
[ -n "$REPO_DIR" ] || die "set REPO_DIR to the checkout to watch, for example /home/${GIT_USER}/makketing"
[ -e "$REPO_DIR/.git" ] || die "$REPO_DIR is not a git checkout"
command -v git >/dev/null || die "git is not installed"
command -v node >/dev/null || die "node is not installed"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "node 20 or newer is needed (found $(node --version))"
command -v npm >/dev/null || die "npm is not installed"
[ -r "$APP_ENV" ] || warn "$APP_ENV not found: put SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM into $CONF yourself"

log "Installing to ${DEST}"
install -d -m 0755 "$DEST"
install -m 0644 "$HERE/notes-core.mjs" "$HERE/watch.mjs" "$HERE/package.json" "$HERE/package-lock.json" "$DEST/"
(cd "$DEST" && npm ci --omit=dev --no-audit --no-fund >/dev/null)

# settings: created once, then only the values given on this command line are changed
[ -f "$CONF" ] || { printf '# push-notes settings (read by push-notes.service)\nPUSH_NOTES_REPO=\nPUSH_NOTES_BRANCH=main\nPUSH_NOTES_FETCH=false\nPUSH_NOTES_ENV=%s\nTEST_NOTES_TO=\n# writes the summary; without it the email only lists the commits\nANTHROPIC_API_KEY=\n' "$APP_ENV" > "$CONF"; }
setvar() { if grep -q "^$1=" "$CONF"; then sed -i "s|^$1=.*|$1=$2|" "$CONF"; else printf '%s=%s\n' "$1" "$2" >> "$CONF"; fi; }
setvar PUSH_NOTES_REPO "$REPO_DIR"
[ -n "${BRANCH:-}" ] && setvar PUSH_NOTES_BRANCH "$BRANCH"
[ -n "${FETCH:-}" ] && setvar PUSH_NOTES_FETCH "$FETCH"
[ -n "${TEST_NOTES_TO:-}" ] && setvar TEST_NOTES_TO "$TEST_NOTES_TO"
chown "root:${GIT_USER}" "$CONF"; chmod 640 "$CONF"      # holds the Anthropic key: only root and the service user can read it
grep -q '^TEST_NOTES_TO=.\+' "$CONF" || die "no recipient yet: run again with TEST_NOTES_TO=name@example.com"

NODE="$(command -v node)"
cat > /etc/systemd/system/push-notes.service <<UNIT
[Unit]
Description=Email the tester what to test when a project's code changes
After=network-online.target
[Service]
Type=oneshot
User=${GIT_USER}
EnvironmentFile=${CONF}
StateDirectory=push-notes
ExecStart=${NODE} ${DEST}/watch.mjs
TimeoutStartSec=300
UNIT
cat > /etc/systemd/system/push-notes.timer <<UNIT
[Unit]
Description=Check for changed code every minute
[Timer]
OnBootSec=2min
OnUnitActiveSec=60s
AccuracySec=10s
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now push-notes.timer >/dev/null
systemctl start push-notes.service || warn "the first run failed: journalctl -u push-notes -n 30"

grep -q '^ANTHROPIC_API_KEY=.\+' "$CONF" || warn "no ANTHROPIC_API_KEY in $CONF: emails will list the commits but not say what to test. Add the key (vi $CONF); no restart is needed."
cat <<DONE

push-notes is watching ${REPO_DIR} (branch $(grep '^PUSH_NOTES_BRANCH=' "$CONF" | cut -d= -f2)) and mails $(grep '^TEST_NOTES_TO=' "$CONF" | cut -d= -f2).
The first run only starts watching: the next change that arrives is mailed.
  see what it did      journalctl -u push-notes -n 30 --no-pager
  send the latest now  sudo -u ${GIT_USER} env \$(grep -v '^#' ${CONF} | xargs) ${NODE} ${DEST}/watch.mjs --resend
  stop                 sudo systemctl disable --now push-notes.timer
DONE
