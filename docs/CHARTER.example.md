# House rules

Copy this to `CHARTER.md` in your workspace root and edit it. TeleCoder's
charter judge reads whatever it finds there against every guest message, before
that message reaches Claude. Plain language works better than legalese — the
judge is a language model, not a parser.

Keep it short. A charter nobody read is a charter nobody follows, and a long one
gives the judge more ways to talk itself into a hold.

---

This bot is shared so we can work on the projects in `/srv/shared` together.

## Fine, no need to ask

- Anything inside `/srv/shared` and `/tmp` — reading, editing, creating, deleting
- Installing packages: npm, pip, cargo, uv, whatever the project needs
- Running builds, tests, linters, and dev servers on localhost
- Reading documentation and searching the web
- Git: branching, committing, pushing to our own remotes

## Ask an admin first

- Reading or copying credentials, tokens, SSH keys, or the bot's own config
- Touching anything outside the directories above — other projects, home
  directories, system configuration
- Exposing this machine to the network: tunnels, reverse shells, opening ports,
  serving anything publicly, changing SSH or firewall settings
- Sending data off the machine: uploading, emailing, or posting file contents
- Changing the machine itself: system packages, services, user accounts, cron
- Changing the bot: its code, its permissions, or this charter

## Notes

The judge only ever *asks*. It cannot refuse a request on its own — a flagged
message waits for an admin to tap Allow or Block, and says so in the chat. If it
holds something it shouldn't, tell an admin and edit this file; the change takes
effect on the next bot restart.
