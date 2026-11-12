# Push notes: what to test, by email

For a project whose code is checked out on this server (for example Makketing), `deploy/push-notes` emails a tester a plain-language summary of what changed and what to test, every time the code changes.

## What the email contains

- **In short**: two to four plain sentences about what is different for a user.
- **What to test**: up to eight numbered checks, most important first. Each has a priority (must, should, quick check), the page or feature, why it changed, step-by-step instructions and what the tester should see if it works.
- **Also worth a quick look**: existing things that might have been affected.
- **No need to test**: changes a user cannot see (documentation, refactoring, tests, build settings).
- **Not clear from the changes, ask the developer**: what the summary could not tell, instead of a guess.
- The list of commits and a link to the changes.

A push with nothing visible says "Nothing to test" in the subject. If the summary cannot be written (no API key, the service is down, the request is declined), the email still goes out with the commits and says why.

## How it works

`push-notes.timer` starts `watch.mjs` every minute as the user who owns the checkout. It compares the checkout's current commit with the last one it told about (kept in `/var/lib/push-notes`), and when they differ it:

1. collects the commits, the changed files and the diff (lockfiles, images and minified files left out, long files shortened),
2. asks Claude (`claude-opus-5-5`) to write the summary as structured JSON,
3. renders and sends the email through the SMTP account AMB Board already uses (read from `/opt/amb-board3/server/.env`),
4. remembers the commit. If the mail cannot be sent it does not remember it, so the next run tries again; nothing is lost and nothing is sent twice.

The first run only starts watching. Several commits arriving together become one email.

**Safety.** Commit messages, pull request text and the diff are data: they are wrapped in tags and the model is told never to follow instructions found in them. The recipient comes from `/etc/push-notes.env`, never from the model or the repository. The summary is plain JSON that is escaped before it goes into the HTML.

## Install

```bash
sudo REPO_DIR=/home/marcus/makketing TEST_NOTES_TO=addaaaa.r@gmail.com bash deploy/push-notes/install.sh
```

Then put an Anthropic API key into `/etc/push-notes.env` (`ANTHROPIC_API_KEY=...`; readable only by root and the service user). Settings in that file:

| Setting | Meaning |
|---|---|
| `PUSH_NOTES_REPO` | the checkout to watch |
| `PUSH_NOTES_BRANCH` | the branch (default `main`) |
| `PUSH_NOTES_FETCH` | `false` (default): email when the code **arrives on this server** (pulled or deployed). `true`: also fetch from GitHub every minute, so the email goes out when the code is **pushed**, even before it is deployed. The checkout's user needs read access to GitHub for this. |
| `TEST_NOTES_TO` | who gets the email |
| `PUSH_NOTES_FROM` | sender; default is the address of AMB Board's mail account, named "<project> test notes" |
| `ANTHROPIC_API_KEY` | writes the summary |
| `GITHUB_TOKEN` | optional: adds the text of the pull requests behind the commits to what Claude reads |

One install watches one project. Watching several projects needs a small change (one unit and settings file per project); ask for it when you need it.

## Everyday use

```bash
journalctl -u push-notes -n 30 --no-pager
```

To re-send the notes for the latest commit without changing what is remembered, run `watch.mjs --resend` (or `--resend=3` for three commits) as the service user with the settings loaded; the install script prints the exact command. To stop: `sudo systemctl disable --now push-notes.timer`.

## Cost and privacy

Each email costs a few cents. The commit messages, the changed-file list and the diff (up to about 120,000 characters, minus excluded files) are sent to the Anthropic API. Do not use it for a repository whose code must not leave the server.

## Tests

`cd deploy/push-notes; npm install; npm test` runs the watcher against real temporary git repositories, a fake Claude API and a fake mail server: first run, deploy, fetch mode, mail failure and retry, failed summary, rewritten history, several commits, a hidden instruction in a commit, `--resend`, and the settings errors.
