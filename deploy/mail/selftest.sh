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
rm -rf "$t"
[ "$fail" = 0 ] && echo "amb-mail-sync selftest: all refusals work"
exit "$fail"
