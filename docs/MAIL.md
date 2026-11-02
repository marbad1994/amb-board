# Email hosting

Owners and admins of a workspace can attach their own domains in **Settings, Email** and create mailboxes and aliases for them. The mail itself is handled by Postfix (receiving and sending), Dovecot (IMAP, logins, storage) and OpenDKIM (signing) on the same server. AMB Board is only the admin screen.

## How the pieces fit

1. AMB Board keeps domains, mailboxes (with a SHA512-CRYPT password hash) and aliases in its database.
2. After every change it writes plain list files to `MAIL_DIR/in` (`domains.txt`, `mailboxes.txt`, `passwd.txt`, `aliases.txt`, `dkim/<domain>.pem`) and then touches `sync-request`.
3. `amb-mail-sync.path` (systemd) notices and starts `/usr/local/sbin/amb-mail-sync`, which runs as root. It checks every line against a strict pattern, builds the real configuration, runs `postmap` and reloads the services. One bad line rejects the whole run and changes nothing. The result is in `MAIL_DIR/out/status.json` and shown in the Email tab.

The web app never runs as root and never writes a Postfix or Dovecot configuration line itself. `deploy/mail/selftest.sh` proves the helper refuses injected lines.

## Setting it up

DNS and provider, before anything else:

- An **A record** for the mail host name (for example `mail.example.com`) pointing at this server.
- A certificate for that name. **With Caddy** (a host service or a Docker container) the setup script asks Caddy for it: it adds a site for the mail host name to the Caddyfile, waits up to 2.5 minutes for the certificate and uses it (the A record must point at this server and Caddy must be reachable on ports 80 and 443). A weekly timer reloads Postfix and Dovecot so a renewed certificate is picked up. **With nginx**: `certbot certonly --nginx -d mail.example.com` first. Or give your own files: `CERT=/path/fullchain.pem KEY=/path/privkey.pem`.
- Your hosting provider must allow mail ports. Many block outgoing port 25; ask them, otherwise mail cannot leave. Ask them to set the **reverse DNS (PTR)** of the server address to the mail host name. Without it much of what you send is marked as spam.
- Open ports 25, 587 and 993 (the script opens them in ufw if it is active; check the provider's firewall too).

Then on the server, once:

```bash
sudo MAIL_HOST=mail.example.com APP_USER=marcus bash deploy/mail/setup-mail.sh
```

`APP_USER` is the user AMB Board runs as. The script installs Postfix, Dovecot and OpenDKIM (Debian or Ubuntu), configures them, installs the helper and its systemd units, and prints the lines to add to `server/.env`:

```
MAIL_ENABLED=true
MAIL_HOST=mail.example.com
MAIL_DIR=/var/lib/amb-mail
MAIL_SERVER_IP=203.0.113.9
```

Redeploy, and the Email tab appears for owners and admins. Limits per workspace: `MAIL_MAX_DOMAINS` (3), `MAIL_MAX_ACCOUNTS` (25), `MAIL_MAX_ALIASES` (100). `MAIL_WORKSPACE_IDS` (comma separated) restricts the feature to some workspaces.

## Attaching a domain

1. Enter the domain. It is **not active** yet: no mail is accepted for it.
2. Add the TXT record shown (`_amb-mail.<domain>`). This proves you control the domain. A domain can belong to only one workspace on the server.
3. Press Check now. The domain becomes verified, a DKIM key is generated and a `postmaster@` alias is created that forwards to you.
4. Open **DNS records** and add MX, SPF, DKIM and DMARC as listed. The tab checks them live and marks each Correct, Missing or Needs attention.
5. Create mailboxes and aliases.

## Your existing mail provider (important)

If the domain already has mail somewhere else (for example makketing.com is on Zoho: MX `smtppro.zoho.eu`), **do not change the MX record until the mailboxes exist here and you have moved what you need.** Changing MX sends all new mail for the whole domain to this server. The DNS tab shows the current MX and warns when it differs.

Moving makketing.com also affects what AMB Board itself uses: `SMTP_USER=admin@makketing.com` on Zoho sends its notification and automation emails. Either keep that mailbox on Zoho (use a different domain here) or create `admin@makketing.com` here and change `SMTP_HOST` to `MAIL_HOST` (port 587 with STARTTLS: `SMTP_SECURE=false`) and its password.

SPF can only be one record per domain. If you send from both places, put both in the same record.

## Mailboxes

- A password is generated unless you type one (at least 12 characters). It is shown once; only a hash is stored and it is never logged.
- "Turn login off" stops logins but still receives mail. Deleting a mailbox stops logins and delivery; the stored messages stay on disk under `/var/vmail/<domain>/<user>` until an administrator removes them.
- Mail apps: IMAP port 993 (SSL/TLS), SMTP port 587 (STARTTLS), user name is the full address.

## Aliases

An alias forwards to one to five addresses, local or outside. `*` is a catch-all for every address that does not exist (it attracts spam). An alias and a mailbox cannot share a name.

## Spam filtering

Rspamd checks every message that arrives from other servers (SPF, DKIM, DMARC, content, blocklists, a learning filter backed by Redis). Spam is not dropped silently: messages that score as spam are filed in the **Junk** folder of the mailbox (a Sieve rule runs for every mailbox), and very high scores are rejected at the door. Mail your users send is signed (DKIM) but not scored. Settings are in `/etc/rspamd/local.d/`. Move a message out of Junk and Rspamd learns from it.

## Sending limits and reputation

All mailboxes of all workspaces send from one server address, so one careless sender can hurt everyone's delivery. One IP means one shared reputation; what the server does about it:

- **Limits**: each recipient of a logged-in sender is counted. Per mailbox (default 60 per hour, 300 per day) and per domain (default 1000 per day). Over a limit the recipient is deferred with a clear message. Change them with `MAIL_SEND_PER_USER_HOUR`, `MAIL_SEND_PER_USER_DAY`, `MAIL_SEND_PER_DOMAIN_DAY`. The Mailboxes tab shows how much each mailbox sent today. The service is `amb-mail-policy`; if it is down, sending is deferred rather than unlimited.
- **Sender check**: on port 587 a mailbox can only send as its own address, or as an alias that forwards to it. Nobody can send as another domain or person.
- **Authentication**: DKIM per domain, SPF and DMARC records are required and checked in the DNS tab.
- Separate addresses per workspace are not possible on one IP. If one workspace needs its own reputation, give it its own server.

## Webmail

`setup-mail.sh` installs Roundcube (PHP-FPM, SQLite) behind nginx or a host Caddy (Caddy serves it through PHP-FPM) on the mail host name (`https://mail.example.com/`) and prints `MAIL_WEBMAIL_URL=...` for `server/.env`; the Email tab then shows an Open webmail button. It signs in with the full address and the mailbox password against the same IMAP and SMTP server. Use `INSTALL_WEBMAIL=no` to skip it. If Caddy runs in a Docker container it cannot run PHP, so webmail is skipped there (mail apps still work): run Roundcube on the server and add a `reverse_proxy` for the mail host name to the Caddyfile. With no web server found the script says so: serve `/usr/share/roundcube` yourself with PHP-FPM.

## Deleting mailboxes

Deleting a mailbox or a domain asks the helper to move the stored mail to `/var/vmail/.trash`, and it is deleted for good after `MAIL_TRASH_DAYS` (default 14). Until then it can be copied back by an administrator, and creating the same address again keeps its mail (the pending removal is cancelled). The request is a list of named addresses, never "everything not in the list", so an empty or broken database cannot wipe the mail.

## Not included

- Per-user quotas on sending beyond the limits above, a separate IP per workspace, and outgoing spam scoring.
- Mail for a workspace that is deleted: its domains disappear from the configuration at the next server start, and its mailboxes are not queued for removal (remove `/var/vmail/<domain>` by hand).
- `setup-mail.sh`, the Rspamd, Sieve, Roundcube and nginx parts included, has not been run on a real machine by the author of this change. Run it on a test server first, or read it before you run it; it changes Postfix, Dovecot, OpenDKIM, Rspamd and nginx configuration.
