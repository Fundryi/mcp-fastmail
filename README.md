# Fastmail MCP

An unofficial [MCP](https://modelcontextprotocol.io) server for Fastmail. It gives an AI assistant your mail, folders, contacts, calendars and files over JMAP, CalDAV and WebDAV, with a safety net under every write.

Built on [MadLlama25/fastmail-mcp](https://github.com/MadLlama25/fastmail-mcp) by Jeremy Gill, MIT. Upstream's 52 tools are all here; 15 of them are re-implemented under the same names with more arguments and a safety net, and 39 are new. On top: an agent skill, and instructions the server sends to every client on connect. Upstream's original README is kept in full at [docs/UPSTREAM-README.md](docs/UPSTREAM-README.md).

> Not affiliated with, endorsed by, or supported by Fastmail. "Fastmail" is a trademark of Fastmail Pty Ltd, used here only to describe compatibility with their public APIs. Use at your own risk under the MIT license.

## Why this one

Three servers can put Fastmail in front of an AI. Each is a step up from the last.

| | Fastmail's own MCP | Upstream fork | This fork |
|---|:---:|:---:|:---:|
| Tools | 30 | 52 | 91 |
| Read, search, send mail | Yes | Yes | Yes |
| Gmail-style search string | No | No | Yes |
| Folders: create, rename, move | No | Create only | Yes, plus merge, delete with contents moved, subtree patch |
| Bulk move, delete, label | No | Yes | Yes |
| Dry run before every bulk write | No | Test tool only | Yes, on every bulk tool |
| Confirm gate above a threshold | No | No | Yes |
| Undo a bulk operation | No | No | Yes, last 50 |
| Audit log of bulk writes | No | No | Yes, optional file |
| Read-only mode | No | No | Yes |
| Reply from the alias that received the mail | No | No | Yes, catch-all included |
| Scheduled send, list, cancel | No | No | Yes |
| Snooze, forward, unsubscribe, report spam | No | No | Yes |
| One-time codes, duplicates, per-sender summary, unread across a tree | No | No | Yes |
| Identities, masked email, aliases with usage, quota, change tracking | No | Identities only | Yes |
| Contacts | Directory search | Yes | Yes |
| Calendar | Yes | Yes, over CalDAV | Yes, over CalDAV or passthrough |
| Notes, email memos, company directory, RSVP | Yes | No | Yes, via passthrough to Fastmail's MCP |
| Server instructions sent on connect | No | No | Yes |
| Agent skill included | No | No | Yes |
| Structured errors an agent can branch on | No | Partly | Yes |
| Permanent delete by default | Yes, confirm widget | Trash | Trash; destroy needs confirm |
| Runs where | Fastmail's cloud, HTTP | Your machine | Your machine, optional cloud passthrough |
| Token type | MCP | JMAP API token | JMAP API token, optional MCP token |

Fastmail's own MCP is the only one that reaches Notes and the company directory. This fork wraps it, so you lose nothing by starting here.

## Contents

- [Why this one](#why-this-one)
- [What you get](#what-you-get)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Safety model](#safety-model)
- [Tools at a glance](#tools-at-a-glance)
- [For AI agents](#for-ai-agents)
- [What Fastmail does not allow](#what-fastmail-does-not-allow)
- [Development](#development)
- [Staying current with upstream](#staying-current-with-upstream)
- [Credits and license](#credits-and-license)

## What you get

| Area | Highlights |
|---|---|
| Mail | List, search with Gmail-style queries, read threads with bodies, one-time codes, duplicates, attachments, unread counts across a folder tree, per-sender summaries |
| Folders | Create, rename, move, subscribe, merge, delete with contents moved first, one patch across a whole subtree |
| Bulk | Move, delete, label, read, pin. Every call has a dry run, a confirm threshold, an operation log and undo |
| Sending | Send and reply from the right alias, catch-all identities included. Schedule, list scheduled, cancel, forward, snooze |
| Account | Identities, masked email, aliases with usage, quota, session capabilities, change tracking |
| Contacts, calendar, files | Upstream's JMAP contacts, CalDAV calendars and WebDAV file save, untouched |
| Optional | A passthrough to Fastmail's own MCP server for Notes, email memos, the company directory and calendar RSVP |

## Quick start

Needs Node.js 20 or newer and a Fastmail API token. Create the token at Fastmail, Settings, Privacy & Security, Integrations, API tokens. Give it the scopes you plan to use: Email, Email submission, Contacts, Masked Email.

```bash
git clone https://github.com/Fundryi/mcp-fastmail.git && cd mcp-fastmail
npm ci
npm run build
cp .env.example .env    # then put your token in FASTMAIL_API_TOKEN
node dist/index.js
```

Register the server in your MCP client as a stdio command, `node /path/to/fastmail-mcp/dist/index.js`, with the variables from `.env` in its environment. The client's own tool prefix goes in front of every tool name.

For Claude Desktop, `npx @anthropic-ai/dxt pack` after the build produces a `.dxt` file you can drag into the app. It asks for the token and the optional CalDAV and WebDAV settings.

## Configuration

Every variable is documented in [.env.example](.env.example). The short version:

| Variable | Needed for |
|---|---|
| `FASTMAIL_API_TOKEN` | Everything. Required |
| `FASTMAIL_CALDAV_USERNAME`, `FASTMAIL_CALDAV_PASSWORD` | Calendar tools. An app password, not the API token |
| `FASTMAIL_WEBDAV_URL`, `FASTMAIL_WEBDAV_USERNAME`, `FASTMAIL_WEBDAV_PASSWORD` | `save_attachment_to_webdav` |
| `FASTMAIL_DOWNLOAD_DIR` | Where attachments may be written. Default `~/Downloads/fastmail-mcp/` |
| `FASTMAIL_READ_ONLY=1` | Refuse every tool that writes. Good for a check-only session |
| `FASTMAIL_BULK_CONFIRM_THRESHOLD` | Bulk calls above this many mails need `confirm: true`. Default 100 |
| `FASTMAIL_AUDIT_LOG` | Append one JSON line per bulk operation to this file |
| `FASTMAIL_MCP_TOKEN` | A second token of type MCP. Turns on the `official_*` passthrough |

## Safety model

A tool never changes more than the caller asked for, and never hides how much it destroys.

- **Dry run, then confirm.** Every bulk tool takes `dryRun: true` and answers with the count and a sample of ids. Above the confirm threshold the real run needs `confirm: true`.
- **Undo.** Every bulk call returns an `operationId`. `undo_operation` puts the previous folders and keywords back. `list_operations` shows the last 50 of the process.
- **Echo what was stored.** Writes re-fetch and return the object as the server has it, not as it was sent.
- **Trash, not destroy.** `delete_email` and `bulk_delete` move to Trash. The only permanent destroys are `empty_mailbox` (Trash or Junk only) and `delete_mailbox`, and both need `confirm: true` and say so.
- **Structured refusals.** A refused or failed call comes back as a tool error with a JSON body: the JMAP error type, or `needsConfirm`, or `readOnly`. Nothing is swallowed.

## Tools at a glance

91 tools. The full reference with every parameter is generated from the server itself: [docs/TOOLS.md](docs/TOOLS.md).

| Group | Tools |
|---|---|
| Find mail | `search_emails` (Gmail-style string), `advanced_search`, `list_emails`, `get_recent_emails`, `list_unread_across`, `summarize_mailbox`, `find_duplicates`, `extract_codes`, `list_attachments` |
| Read mail | `get_email`, `get_thread`, `get_email_metadata`, `get_email_attachments`, `download_attachment` |
| Change mail | `move_email`, `mark_email_read`, `archive_email`, `pin_email`, `add_labels`, `remove_labels`, `report_spam`, `report_not_spam`, `unsubscribe`, `snooze_email`, `import_email` |
| Bulk | `bulk_move`, `bulk_delete`, `bulk_mark_read`, `bulk_pin`, `bulk_add_labels`, `bulk_remove_labels`, `list_operations`, `undo_operation`, `export_operation_log` |
| Folders | `list_mailboxes`, `get_mailbox`, `get_mailbox_by_name`, `create_mailbox`, `update_mailbox`, `bulk_update_mailboxes`, `merge_mailbox`, `delete_mailbox`, `empty_mailbox` |
| Send | `send_email`, `reply_email`, `forward_email`, `create_draft`, `edit_draft`, `send_draft`, `list_scheduled`, `cancel_send` |
| Account | `get_session`, `get_account_summary`, `list_identities`, `create_identity`, `update_identity`, `list_aliases_with_usage`, masked email, vacation responder, sieve, `get_quota`, `get_changes` |
| Contacts and calendar | `list_contacts`, `search_contacts`, `get_contact`, `create_contact`, `update_contact`, `delete_contact`, `list_address_books`, `list_calendars`, `list_calendar_events`, `create_calendar_event`, `update_calendar_event`, `delete_calendar_event` |
| Official passthrough | `official_create_note`, `official_search_notes`, `official_set_memo`, `official_search_org_contacts`, `official_rsvp_event` and friends. Only with `FASTMAIL_MCP_TOKEN` |

Sieve, quota and the vacation responder exist as tools, but a plain API token has no capability for them. They refuse and name the missing capability. See [What Fastmail does not allow](#what-fastmail-does-not-allow).

## For AI agents

Three things teach an agent to use this server well. Each works alone; together they are best.

1. **Server instructions.** The server sends a short guide on connect: which tool fits which task, how to keep results small, the dry run then confirm flow. Every MCP client that honours `instructions` gets it for free. Source: [src/fork/instructions.ts](src/fork/instructions.ts).
2. **The skill.** [skills/fastmail-mcp/SKILL.md](skills/fastmail-mcp/SKILL.md) is the long form with recipes and a checklist for folder work. Copy the folder into your agent's skills directory. It names tools by their bare name and does not depend on any one client.
3. **[llms.txt](llms.txt).** An index of the files an agent should read when it works on this repo rather than through it.

## What Fastmail does not allow

Checked live against a real account. These are limits of the API token, not of this server.

| Want | Reality | Instead |
|---|---|---|
| Folder colour | Not in JMAP. The server rejects the property | Web app |
| Identity link, auto purge, spam learning on a folder | Read-only over JMAP. `get_mailbox` shows them | Web app, folder settings |
| Sieve rules, quota, vacation responder | No such scope on an API token | Web app |
| DKIM and MX status | No API | A DNS lookup on the domain |
| Notes, email memos, company directory, RSVP | Not in JMAP token scopes | The `official_*` passthrough with a token of type MCP |
| Snooze before the Snoozed folder exists | Fastmail creates it on first use | Snooze one mail in the web app once |
| Push on new mail | MCP has no long-running process | A cron job calling `get_changes` |

## Development

TypeScript, npm, Node 20 or newer.

```bash
npm ci
npm run build          # tsc to dist/
npm test               # node test runner over src/*.test.ts and src/fork/*.test.ts
npm run scan:secrets   # upstream's secret and PII scanner, run before every push
npm run docs:tools     # regenerate docs/TOOLS.md from the built server
```

Tests mock the transport. They prove the shape of a call, not that Fastmail accepts it. Anything that touches the network gets a live run before it is called done. On Windows, three upstream symlink tests fail without Developer Mode; everything else must be green.

Layout:

```
src/index.ts          upstream's server, plus a few hook lines for the fork
src/fork/             every fork tool, one file per group, and the registry
src/fork/instructions.ts   the text sent to clients on connect
skills/fastmail-mcp/  the agent skill
docs/TOOLS.md         generated tool reference
docs/UPSTREAM-README.md    upstream's README, verbatim
scripts/check-upstream.mjs new upstream commits and files we both touched
```

Working rules for this repo are in [AGENTS.md](AGENTS.md). Upstream's own guide, including CalDAV and WebDAV setup, attachments on send, contacts scope, and troubleshooting, is [docs/UPSTREAM-README.md](docs/UPSTREAM-README.md).

## Staying current with upstream

This is not a GitHub fork. It is an independent repo with upstream's history underneath, so it can stay private and still merge upstream cleanly. Changes to upstream files stay additive, and new behaviour lives in new files.

```bash
npm run check:upstream    # fetches upstream, writes UPSTREAM-UPDATE.md when there is news
git merge upstream/main
npm ci && npm run build && npm test && npm run scan:secrets && npm run docs:tools
```

VS Code runs the check on folder open. `FORK_TOUCHED` in `scripts/check-upstream.mjs` lists the upstream files we edited, so the check flags them before a merge.

## Credits and license

- [MadLlama25/fastmail-mcp](https://github.com/MadLlama25/fastmail-mcp) by Jeremy Gill is the base of everything here. Thank you.
- Upstream credits the [Fastmail JMAP-Samples](https://github.com/fastmail/JMAP-Samples) for several patterns.
- MIT, same as upstream. See [LICENSE](LICENSE).
