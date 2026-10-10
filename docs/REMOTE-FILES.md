# Files when the MCP server runs on another machine

For agents and people using this server through MCPHub or another remote host.

## When you need this

| Setup | What to do |
|---|---|
| Server installed on the same machine as your AI client | Nothing. Use `localPath` (inside `FASTMAIL_DOWNLOAD_DIR`) and `savePath`. |
| Server runs elsewhere (MCPHub, a container, another PC) | Read on. A path from your machine does not exist on the server. |
| The file is already in the account | Nothing. Re-attach with `emailId` + `attachmentId`, no bytes move. |

## Why

An MCP tool call is text that the model writes. MCP has no way yet for the
client to attach a file from its disk to a call (proposal: [SEP-2631 File
Objects and Transfer](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2631),
still a draft). So a file can reach a remote server only inside the call, as
base64. For a few KB the model can do that itself. A 1 MB PDF is about 1.3
million characters, which fills the model's context.

## Small files: base64 content

Attachment entries on `send_email`, `reply_email`, `forward_email`,
`create_draft` and `edit_draft` take a fourth source:

```json
{"attachments": [{"content": "<standard base64>", "name": "notes.txt", "type": "text/plain"}]}
```

Standard base64 (`+` and `/`). `name` is required. The size is checked
against the account's live upload limit before anything is sent.

`download_attachment` with `base64: true` returns `{name, type, size, base64}`.

## Large files: the helper script

The helper lives in the sibling Google Workspace fork and works for any
server behind MCPHub: [mcp_file_call.py](https://github.com/Fundryi/mcp-google-workspace/blob/main/scripts/mcp_file_call.py).
Set-up, hub address and key, and hub size settings:
[REMOTE-FILES.md there](https://github.com/Fundryi/mcp-google-workspace/blob/main/docs/REMOTE-FILES.md).

Send:

```json
{
  "to": ["someone@example.com"],
  "subject": "Report",
  "textBody": "Attached.",
  "attachments": [{"content": "@file:/home/me/report.pdf", "name": "report.pdf", "type": "application/pdf"}]
}
```

```bash
python3 ~/.local/bin/mcp_file_call.py fastmail create_draft args.json
```

Save:

```json
{"emailId": "M123", "attachmentId": "2", "base64": true}
```

```bash
python3 ~/.local/bin/mcp_file_call.py fastmail download_attachment args.json --out report.pdf
```

`fastmail` is the server name in your hub.

## Limits

- Fastmail: 50 MB of attachments per email, 70 MB per whole message. The
  server reads `maxSizeUpload` from the session and refuses larger content
  before decoding.
- The stdio read buffer is 256 MiB (the SDK default of 10 MiB dropped larger
  requests without an answer).
- MCPHub must accept the request: see the hub settings table in the guide
  linked above. For 50 MB attachments the JSON body limit needs `70mb`.

## Agents without a shell

Chat apps without a terminal cannot run the script. They are limited to small
base64 files until MCP gains file transfer.
