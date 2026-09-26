// Server instructions, sent to every MCP client on connect. Public-safe: no
// account details. The long form with account specifics lives in the owner's
// skill file outside this repo.
export const INSTRUCTIONS = `Fastmail over JMAP. Folders are labels: one email can sit in several mailboxes, and every user folder lives under Inbox.

FIRST CALLS IN A SESSION
- list_mailboxes with properties ["id","name","parentId","role","totalEmails","unreadEmails"]: the whole folder tree in one call. Work by id after that.
- check_function_availability: which of contacts, calendars (CalDAV) and files (WebDAV) are set up. get_session: what the API token can reach.
- Every tool carries readOnlyHint. Read-only tools are safe to call freely; the rest change the account.

PICK THE TOOL BY TASK, NOT BY KEYWORD
- Counts per sender, recipient or subject: summarize_mailbox. Never page list results to count.
- Unread across a folder tree: list_unread_across.
- Search with folder scope: advanced_search with mailboxId + includeChildren: true. toDomain: "example.com" matches every alias on a domain. excludeMailboxIds also expands with includeChildren.
- One-time codes: extract_codes (digits by default; pass pattern for letters).
- Duplicates: find_duplicates. Attachments across mails: list_attachments. Full bodies of a conversation: get_thread.
- Which aliases are dead: list_aliases_with_usage. Token capabilities: get_session.
- What changed since last time: get_changes (call once without sinceState, keep the states).

KEEP PAYLOADS SMALL
- Every list tool takes fields. Ask for what you need: ["id","from","subject","receivedAt"]. Default output is about 400 bytes per email.
- limit caps at 500. Use position to page. Prefer a summary tool over paging.
- list_mailboxes with properties ["id","name","parentId","role","totalEmails","unreadEmails"] gives the whole tree cheaply. Mailbox ids are stable; use them instead of paths in loops.

PATHS
- A path is "Inbox/Parent/Child". The tools also accept "Parent/Child" and try the Inbox prefix. A folder name may contain "@" and spaces.

WRITES: DRY RUN, THEN CONFIRM
- bulk_* tools take emailIds, a mailboxId or a filter. Run with dryRun: true first, read the count, then run for real. Above the confirm threshold (env FASTMAIL_BULK_CONFIRM_THRESHOLD, default 100) pass confirm: true.
- Every bulk call returns an operationId. undo_operation restores the previous folders and keywords. list_operations shows the last 50 of this process.
- bulk_delete and delete_email move to Trash. The only permanent destroys are empty_mailbox (Trash or Junk) and delete_mailbox with onDestroyRemoveEmails; both need confirm: true and say so.
- create_mailbox subscribes the folder by default, as the web app does. After creating folders, check isSubscribed on each; bulk_update_mailboxes with parentId fixes a whole subtree in one call (dryRun first).
- Mailbox writes accept only name, parentId, isSubscribed and sortOrder. identityRef, autoPurge, learnAsSpam, isCollapsed and colour are read-only with an API token; the server answers invalidProperties. Set them in the web app. get_mailbox shows their current values.
- FASTMAIL_READ_ONLY=1 makes every write tool refuse.

SENDING
- send_email and reply_email choose the From identity by identityId or fromEmail. A reply defaults to the identity the original was addressed to, including *@domain catch-all identities. sendAt schedules; list_scheduled and cancel_send manage it.
- snooze_email needs a mailbox with role "snoozed". Fastmail creates it the first time snooze is used in the web app.

SEARCH SYNTAX
- search_emails takes a Gmail-style string: from:, to:, cc:, subject:, body:, has:attachment, is:unread, is:flagged, in:<folder path or role>, -in:, after:, before:, newer_than:7d, larger:1M, header:Name=value, domain:. The answer includes "parsed", the filter the string became.

OFFICIAL PASSTHROUGH (only when FASTMAIL_MCP_TOKEN is set)
- Tools prefixed official_ come from Fastmail's own MCP server: Notes, a memo on an email, the company directory, calendar RSVP and compose. Use them only for those jobs; everything else is faster and safer through the local tools.
- official_delete_* and official_compose_event only stage a confirm widget. Without widget support in the host nothing changes; tell the user to finish in the web app.

NOT AVAILABLE ON AN API TOKEN
- Sieve rules, quota, vacation responder: the tools exist and refuse with the missing capability named. Folder colour and DKIM/MX status: not reachable over JMAP at all.

ERRORS
- A failed call is a tool result with isError: true and a JSON body: { error } plus { jmap: { type, description } } for a server error, or for a refusal { count, threshold } (bulk above the confirm threshold), { needsConfirm } (permanent destroy or overwrite), { readOnly } or { capability } (token lacks the scope; do not retry). Read jmap.type before retrying; fix the argument the error names. Only an unknown tool name is a protocol error (-32602).`;
