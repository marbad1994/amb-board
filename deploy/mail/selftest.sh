#!/usr/bin/env bash
# Checks that amb-mail-sync refuses input the web app could never produce. Usage: bash selftest.sh   (no root, nothing installed)
set -u
here="$(cd "$(dirname "$0")" && pwd)"; t="$(mktemp -d)"; fail=0
mkdir -p "$t/in/dkim"
printf 'good.org\tmail\n' > "$t/in/domains.txt"
printf 'me@good.org\t1024\n' > "$t/in/mailboxes.txt"
printf '' > "$t/in/passwd.txt"; printf '' > "$t/in/aliases.txt"
run() { python3 "$here/amb-mail-sync" --dir "$t" --root "$t/root" --no-services >/dev/null 2>&1; }
run || { echo "FAIL: a clean input was refused"; fail=1; }
before="$(cat "$t/root/etc/postfix/vmailbox")"
try() {  # name file content
  local keep; keep="$(cat "$t/in/$2")"; printf '%b' "$3" >> "$t/in/$2"
  if run; then echo "FAIL: accepted $1"; fail=1; else grep -q '"ok": false' "$t/out/status.json" || { echo "FAIL: no error status for $1"; fail=1; }; fi
  [ "$(cat "$t/root/etc/postfix/vmailbox")" = "$before" ] || { echo "FAIL: $1 changed the configuration"; fail=1; }
  printf '%s\n' "$keep" > "$t/in/$2"
}
try "a mailbox on an unlisted domain" mailboxes.txt 'x@evil.org\t1024\n'
try "a newline-injected alias" aliases.txt 'a@good.org\tb@c.org\nroot@good.org\t/etc/passwd\n'
try "an alias to a command" aliases.txt 'a@good.org\t|/bin/sh\n'
try "an alias that is also a mailbox" aliases.txt 'me@good.org\tb@c.org\n'
try "too many destinations" aliases.txt 'a@good.org\t1@x.org,2@x.org,3@x.org,4@x.org,5@x.org,6@x.org\n'
try "a quota out of range" mailboxes.txt 'big@good.org\t999999\n'
try "a password that is not a hash" passwd.txt 'me@good.org\tplaintext\n'
try "an extra field" domains.txt 'other.org\tmail\textra\n'
try "a bad key file" dkim/good.org.pem '' 2>/dev/null || true
printf 'not a key' > "$t/in/dkim/good.org.pem"
run && { echo "FAIL: accepted a bad key file"; fail=1; }

# ---- deleted mailboxes: moved to a trash folder, never for a mailbox that exists, never outside /var/vmail, emptied after the retention period
t2="$(mktemp -d)"; mkdir -p "$t2/in/dkim" "$t2/root/var/vmail/good.org/gone" "$t2/root/var/vmail/good.org/me" "$t2/root/var/vmail/good.org/outside"
printf 'good.org\tmail\n' > "$t2/in/domains.txt"; printf 'me@good.org\t1024\n' > "$t2/in/mailboxes.txt"; : > "$t2/in/passwd.txt"
printf 'x@y.org\t1\n' > /dev/null
printf 'me@good.org\tme@good.org\n' > /dev/null
printf 'info@good.org\tme@good.org,out@else.org\n' > "$t2/in/aliases.txt"
printf '*\t10\t50\t500\ngood.org\t5\t20\t100\n' > "$t2/in/limits.txt"; printf 'trash_days\t14\n' > "$t2/in/settings.txt"
printf 'gone@good.org\t2026-01-01T00:00:00Z\nme@good.org\t2026-01-01T00:00:00Z\n' > "$t2/in/purge.txt"
python3 "$here/amb-mail-sync" --dir "$t2" --root "$t2/root" --no-services >/dev/null 2>&1 || { echo "FAIL: purge input was refused"; fail=1; }
[ ! -d "$t2/root/var/vmail/good.org/gone" ] && ls "$t2/root/var/vmail/.trash" | grep -q '^good.org__gone__' || { echo "FAIL: a deleted mailbox was not moved to the trash"; fail=1; }
[ -d "$t2/root/var/vmail/good.org/me" ] || { echo "FAIL: a mailbox that still exists was purged"; fail=1; }
[ -d "$t2/root/var/vmail/good.org/outside" ] || { echo "FAIL: a mailbox nobody asked about was removed"; fail=1; }
grep -q $'^info@good.org\tme@good.org$' "$t2/root/etc/postfix/sender_login" && grep -q $'^me@good.org\tme@good.org$' "$t2/root/etc/postfix/sender_login" || { echo "FAIL: sender map is wrong"; fail=1; }
grep -q $'^good.org\t5\t20\t100$' "$t2/root/etc/amb-mail/limits" || { echo "FAIL: limits file is wrong"; fail=1; }
old="$t2/root/var/vmail/.trash/good.org__old__$(( $(date +%s) - 20*86400 ))"; mkdir -p "$old"
python3 "$here/amb-mail-sync" --dir "$t2" --root "$t2/root" --no-services >/dev/null 2>&1
[ ! -d "$old" ] && ls "$t2/root/var/vmail/.trash" | grep -q '^good.org__gone__' || { echo "FAIL: trash retention is wrong"; fail=1; }
for bad in '../etc\t2026-01-01T00:00:00Z' 'a/b@good.org\t2026-01-01T00:00:00Z' 'gone@good.org\tyesterday'; do
  printf "$bad\n" > "$t2/in/purge.txt"; python3 "$here/amb-mail-sync" --dir "$t2" --root "$t2/root" --no-services >/dev/null 2>&1 && { echo "FAIL: accepted purge line $bad"; fail=1; }
done
rm -rf "$t2"

# ---- sending limits over a real socket
t3="$(mktemp -d)"; printf '*\t2\t10\t100\n' > "$t3/limits"
python3 "$here/amb-mail-policy" --socket "$t3/s" --db "$t3/db" --limits "$t3/limits" --usage "$t3/usage.json" >/dev/null 2>&1 & pol=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -S "$t3/s" ] && break; sleep 0.3; done
out="$(python3 - "$t3/s" <<'PY'
import socket, sys
def ask(user):
    c = socket.socket(socket.AF_UNIX); c.connect(sys.argv[1])
    c.sendall(('request=smtpd_access_policy\nprotocol_state=RCPT\nsasl_username=%s\n\n' % user).encode()); r = c.recv(300).decode(); c.close(); return r.split('\n')[0]
print(','.join([ask('a@b.org'), ask('a@b.org'), ask('a@b.org')[:15], ask('c@b.org'), ask('')]))
PY
)"
kill "$pol" 2>/dev/null; rm -rf "$t3"
[ "$out" = "action=dunno,action=dunno,action=450 4.7.,action=dunno,action=dunno" ] || { echo "FAIL: sending limits: $out"; fail=1; }

rm -rf "$t"
[ "$fail" = 0 ] && echo "amb-mail-sync selftest: all refusals work"
exit "$fail"
