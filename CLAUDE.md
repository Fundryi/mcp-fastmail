# CLAUDE.md

Rules for working in this repo. Private notes with local paths and account
details live in CLAUDE.local.md, which is gitignored.

## What this is

A private fork of [MadLlama25/fastmail-mcp](https://github.com/MadLlama25/fastmail-mcp),
an unofficial MCP server for Fastmail over JMAP, CalDAV and WebDAV. It is not a
GitHub fork: it is an independent repo with upstream's history underneath, so it
can stay private and still merge upstream cleanly.

- `origin` is our repo. Push here.
- `upstream` is read only. Never push to it.

## Upstream merges

`npm run check:upstream` fetches upstream and writes UPSTREAM-UPDATE.md when
there are new commits. VS Code runs it on folder open.

Keep our changes to upstream files additive. New behaviour goes in new files
where possible, so a merge stays a merge and not a rewrite. When you do edit an
upstream file, add it to `FORK_TOUCHED` in `scripts/check-upstream.mjs` so the
next merge flags it.

## Secrets

Treat this repo as if it could go public tomorrow. It will not, but that is the
bar.

- Credentials live in `.env` (gitignored). `.env.example` documents the names
  and never holds a value.
- No real email address, mailbox id, domain or token in code, tests, comments
  or committed docs. Use `user@example.com`.
- `npm run scan:secrets` runs upstream's scanner. Run it before every push.
  A personal denylist goes in `.secret-scan-local.txt` (gitignored); copy
  `.secret-scan-local.txt.example` to start one.

## Safe writes

A tool must never change more than the caller asked for, and never hide how
much it destroys.

- Read, merge, write for a partial update. A missing field must not become a
  wiped field.
- Echo back what was stored, not what was sent. The server may rewrite a value
  on the way in, and the caller cannot see it otherwise.
- Size the friction to the blast radius: `dryRun` for anything driven by a
  query, an explicit confirm for a named target whose cost is hidden, nothing
  for an ordinary single write.

## No permanent delete

Move to Trash, never destroy. Trash can be undone; a JMAP `destroy` cannot.
Any tool that would permanently remove mail, a calendar event or a file needs a
deliberate decision, not a default.

## Tests

`npm test` runs the node test runner over `src/*.test.ts`. Those tests mock the
transport, so they prove the shape of a call and nothing more. A green suite is
not evidence a tool works against Fastmail.

Anything that touches the network needs a live smoke run against a real account
before it is called done. Say plainly which of the two actually happened.

On Windows, 3 upstream tests always fail with `EPERM ... syscall: 'symlink'`
(`safeWritePath (symlink escapes)` twice and `validateReadPath` once, in
`src/jmap-client.test.ts`). Creating a symlink needs Developer Mode or an
elevated shell. They pass on Linux and in CI. Everything else must be green.

## House style

TypeScript, npm, Node 20+. `npm ci`, `npm run build`, `npm test`,
`npm run scan:secrets`. Match upstream's conventions in files we add.

## GitHub Actions in this fork

Upstream ships release automation. In our repo it cut a `v1.13.4` tag and a
release at the wrong commit, which then fought with upstream's real tag on
every pull. **Build and Release DXT** and **Create Tag** are disabled on
GitHub, as a switch rather than a file edit, so upstream merges stay clean.
`test`, `Secret & PII scan` and `npx smoke` stay on.

Tags come from `upstream` only. Never run `git fetch --prune-tags` against
`origin`: origin holds no tags, so it deletes every upstream tag you have.
Restore with `git fetch upstream --tags`.
