/**
 * The MCP tool result for the bot's answer to a tool's IPC request.
 *
 * Kept out of mcp-server.ts, which starts serving on stdio as soon as it is
 * loaded, so it can be tested on its own.
 */

/** What the bot answers a tool's IPC request with. */
export interface IpcReply {
  success?: boolean;
  message?: string;
}

/**
 * `reply` as a tool result. An answer without a message — the ack the bot
 * gives a request it ignores — would otherwise make a text block with no text,
 * which the MCP SDK rejects with a -32602 schema dump that says nothing of
 * what went wrong.
 */
export function toolResult(reply: IpcReply): { content: { type: 'text'; text: string }[]; isError: boolean } {
  if (typeof reply.message !== 'string') {
    return {
      content: [{ type: 'text', text: 'TeleCoder answered without saying what happened, so this may not have been done.' }],
      isError: true,
    };
  }
  return { content: [{ type: 'text', text: reply.message }], isError: !reply.success };
}
