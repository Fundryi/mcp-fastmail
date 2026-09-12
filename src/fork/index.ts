// Registry for fork-only tools. index.ts calls three functions from here and
// nothing else, so upstream merges stay a merge.
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { JmapClient } from '../jmap-client.js';
import { ForkTool, JmapError, RefusedError, ToolDef, isReadOnly, text } from './core.js';
import { tools as mailboxes } from './mailboxes.js';
import { tools as emails } from './emails.js';
import { tools as bulk } from './bulk.js';
import { tools as account } from './account.js';
import { tools as sending } from './sending.js';

const all: ForkTool[] = [...mailboxes, ...emails, ...bulk, ...account, ...sending];
const byName = new Map(all.map((t) => [t.def.name, t]));

// Upstream tools that change state. Fork tools carry their own `write` flag.
const UPSTREAM_WRITE = new Set([
  'create_mailbox', 'send_email', 'reply_email', 'create_draft', 'edit_draft', 'send_draft',
  'create_contact', 'update_contact', 'delete_contact',
  'create_calendar_event', 'update_calendar_event', 'delete_calendar_event',
  'mark_email_read', 'pin_email', 'delete_email', 'move_email', 'archive_email',
  'add_labels', 'remove_labels', 'download_attachment', 'save_attachment_to_webdav',
  'bulk_mark_read', 'bulk_pin', 'bulk_move', 'bulk_delete', 'bulk_add_labels', 'bulk_remove_labels',
  'test_bulk_operations',
]);

/** Fork definitions first; an upstream tool with the same name is replaced. */
export function mergeForkTools(upstream: ToolDef[]): ToolDef[] {
  return [...all.map((t) => t.def), ...upstream.filter((t) => !byName.has(t.name))];
}

/** Run a fork tool. Returns undefined when `name` is not ours. */
export async function runForkTool(name: string, args: unknown, client: JmapClient): Promise<any> {
  const tool = byName.get(name);
  if (!tool) return undefined;
  guardReadOnly(name, tool.write);
  try {
    return text(await tool.run((args ?? {}) as Record<string, any>, { client }));
  } catch (e) {
    throw toMcpError(e);
  }
}

export function guardReadOnly(name: string, write = UPSTREAM_WRITE.has(name)): void {
  if (write && isReadOnly()) {
    throw new McpError(ErrorCode.InvalidRequest, `Refused: ${name} writes and FASTMAIL_READ_ONLY is set`, { readOnly: true });
  }
}

/** Keep the JMAP error type as structured data instead of prose only. */
export function toMcpError(e: unknown): McpError {
  if (e instanceof McpError) return e;
  if (e instanceof JmapError) {
    return new McpError(ErrorCode.InternalError, e.message, { jmap: { type: e.type, description: e.description, detail: e.detail } });
  }
  if (e instanceof RefusedError) {
    return new McpError(ErrorCode.InvalidRequest, e.message, e.detail as any);
  }
  return new McpError(ErrorCode.InternalError, `Tool execution failed: ${e instanceof Error ? e.message : String(e)}`);
}
