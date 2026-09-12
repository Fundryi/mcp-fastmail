---
name: fastmail-mcp
description: Use when a task touches a Fastmail account through the Fastmail MCP tools (list_emails, advanced_search, bulk_*, *_mailbox, send_email, and friends), or mentions alias folders, catch-all domains, one-time codes in mail, or a mailbox sweep. Also use before any bulk move, delete or folder change on Fastmail.
argument-hint: "[task]"
---

# Fastmail MCP

This file names tools by their bare name, for example `summarize_mailbox`.
The client adds a prefix that depends on how the server was registered, such
as `mcp__fastmail__`. Look at the tool list you have and match the bare name.
When tools are deferred, load them by exact full name; keyword search misses
the summary tools.

The server also sends instructions on connect. When the two disagree, the
server text is newer.

## How Fastmail is shaped

- Folders are labels. One email can sit in several mailboxes at once.
- Every user folder sits under **Inbox**. The full path is
  `Inbox/Parent/Child`. Every `path` argument, `get_mailbox_by_name` included,
  also accepts `Parent/Child` and tries the Inbox prefix.
- A folder name may contain `@` and spaces. Alias folders are often named as
  the address itself.
- Mailbox ids are stable. Fetch the whole tree once with `list_mailboxes` and
  `properties: ["id","name","parentId","role","totalEmails","unreadEmails"]`,
  then use ids.
- Identities: `list_identities`. A `*@domain` identity is a catch-all.
  `list_aliases_with_usage` shows which addresses ever received mail.
- `get_session` shows what the API token can reach. A normal token has mail,
  submission, contacts and masked email. Sieve, quota and vacation responder
  are usually missing; those tools refuse and name the capability. Do not
  retry them.
- `snooze_email` needs a mailbox with role `snoozed`. Fastmail creates it the
  first time snooze is used in the web app.

## Pick the tool by task

| Task | Tool | Not this |
|---|---|---|
| Count mails per sender, recipient or subject | `summarize_mailbox` with `mailboxId` + `includeChildren` | paging `advanced_search` and counting |
| Unread per folder in a tree | `list_unread_across` with `path` or `mailboxId` | `list_mailboxes` and filtering by hand |
| All mail to one domain across the tree | `advanced_search` with `toDomain` + `mailboxId` + `includeChildren` | one call per folder |
| Mail in a parent but not in its subfolders | `list_mailboxes`, read `totalEmails` of the parent. For the addresses, `summarize_mailbox` on that parent without `includeChildren` and read `byTo` | `excludeMailboxIds` with every leaf id |
| Find a one-time or 2FA code | `extract_codes`, add `from` or `to`; pass `pattern` for letters | opening mails one by one |
| Read a whole conversation | `get_thread` with the email id | `get_email` per message |
| Which aliases are dead | `list_aliases_with_usage` | one search per identity |
| Raw folder settings | `get_mailbox` | `list_mailboxes` with `properties` (Fastmail rejects unknown names) |
| What is new since the last sweep | `get_changes` with the saved states | listing everything again |
| Attachments of one type in a folder | `list_attachments` with `path` and `type` | `get_email_attachments` per mail |

## Search in one string

`search_emails` reads Gmail-style operators: `from:`, `to:`, `cc:`,
`subject:`, `body:`, `has:attachment`, `is:unread`, `is:flagged`,
`in:<path or role>`, `-in:`, `after:`, `before:`, `newer_than:7d`,
`larger:1M`, `header:Name=value`, `domain:example.com`. Bare words are free
text. The answer carries `parsed`, the filter it became; check it when a
result looks off.

## Official passthrough, when configured

Tools prefixed `official_` exist only when the server has a second token of
type MCP. They reach Fastmail Notes, a memo on an email, the company
directory, calendar RSVP and a calendar compose widget. Use them for those
jobs only. Mail, folders and bulk work stay on the local tools.

`official_delete_note`, `official_delete_event`, `official_delete_contact`
and `official_compose_event` only stage a confirm widget. In a host without
widgets nothing happens; say so and let the user finish in the web app.

## Keep results small

- Pass `fields` on list and search tools. `["id","from","subject","receivedAt"]`
  is a tenth of the default. A default item is about 400 bytes, so 150 items
  spill past most result windows. Summary tools have no `fields`; their output
  is small by design.
- `limit` caps at 500. Page with `position`. If you page more than twice, a
  summary tool exists for the job.

## Writes: dry run, count, confirm

1. Run the bulk tool with `dryRun: true`. Read `count`. The dry run lists up
   to 200 ids. Bulk tools scope by `emailIds`, one `mailboxId` or a `filter`;
   they have no `includeChildren`, so pass the leaf folder id.
2. Run it for real. Above the confirm threshold (default 100) add
   `confirm: true`. Keep the `operationId` from the answer.
3. Check `storedSample` in the answer. It is what the server stored, not what
   was sent.
4. Wrong result: `undo_operation` with that id. It restores folders and
   keywords.

`bulk_delete` and `delete_email` move to Trash. The only permanent destroys
are `empty_mailbox` and `delete_mailbox` with `onDestroyRemoveEmails: true`.
Both need `confirm: true`. Do not pass it on the user's behalf; ask.

Mailbox writes accept `name`, `parentId`, `isSubscribed`, `sortOrder`. The
identity link, colour, auto purge and spam learning are read-only over JMAP
with an API token; the server answers `invalidProperties`. `get_mailbox`
still shows them.

`FASTMAIL_READ_ONLY=1` on the server makes every write tool refuse. Use it
for a check-only session.

## After creating folders

The web app subscribes a new folder on its own. Raw JMAP does not, and an
unsubscribed folder is hidden in IMAP clients. `create_mailbox` now sends
`isSubscribed: true` unless told otherwise, but check anyway; an older server
build did not.

1. `list_mailboxes` with `properties: ["id","name","parentId","role","isSubscribed"]`.
   Every folder you made must show `isSubscribed: true` under the right parent.
2. If any is false, `bulk_update_mailboxes` with `parentId` of the folder you
   built under and `isSubscribed: true`. Dry run, then for real. It skips
   folders with a role and folders already set.
3. Colour, the identity link and auto purge cannot be set over JMAP. List
   them for the user as web app steps; do not try.
4. Leave system folders (any with a `role`) and Fastmail's own "Memos"
   folder alone.

## Recipes

**New alias folder with platform subfolders.** `create_mailbox` with `name`
set to the address and `parentId` set to the domain folder id. Then one
`create_mailbox` per platform with `parentId` set to the new id. The identity
link is a web app step; say so in the report.

**Find unknown aliases.** `summarize_mailbox` with `mailboxId` of the domain
folder and `includeChildren: true`. Compare `byTo` with the alias folder names
from `list_mailboxes`. An address in `byTo` without a folder is new.

**File loose mail into a platform folder.** `bulk_move` with `filter`
`{ from: "sender.example", to: "alias@example.com" }` and `targetMailboxId`.
Dry run first. This replaces all folder memberships.

**Reply from the alias that received the mail.** `reply_email` with only
`originalEmailId` and the body. The From identity is picked from the original
To address, catch-all included. Pass `fromEmail` to override.

**Send later.** `send_email` with `sendAt` in ISO 8601 UTC. `list_scheduled`
shows it. `cancel_send` with the submission id stops it.

**Weekly sweep.** `list_unread_across` on each domain folder, then
`summarize_mailbox` with `after` set to seven days ago, then `get_changes`
without arguments to store new state strings for the next run.

## Not possible here, and what to do instead

| Want | Reality | Instead |
|---|---|---|
| Folder colour | Not in JMAP. Server rejects the property | Web app |
| Sieve rules | No sieve capability on API tokens | Web app, rules editor |
| Identity link on a folder | Read-only over JMAP | Web app, folder settings |
| DKIM, MX status | No API | DNS lookup on the domain |
| Notes, email memos, company directory, RSVP | Not in JMAP token scopes | `official_*` tools with a second token of type MCP |
| Push on new mail | MCP has no long-running process | A cron job calling `get_changes`, outside the MCP |
| PDF text | No parser in the server | `download_attachment`, then read the file |

## After a rebuild

`npm run build` in the repo, then restart the server in the client that hosts
it. A hub does not restart it on its own. A new session sees new tool names;
an open session keeps the old list.
