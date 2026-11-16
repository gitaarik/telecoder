/**
 * MCP Tools — In-process MCP server factory for TeleCoder.
 *
 * Wraps existing standalone functions (project management, files, questions)
 * as MCP tools so Claude can invoke them automatically
 * based on conversation context instead of requiring explicit /commands.
 */

import { z } from 'zod';
import { sanitizeError } from '../utils/sanitize.js';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { InputFile, type Context } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config.js';
import { sessionManager } from './session-manager.js';
import { getWorkspaceRoot, isPathWithinRoot } from '../utils/workspace-guard.js';
import { resolveSendablePath, sendableRefusalMessage } from '../bot/file-access.js';
import { setSessionTopic, clearTopic } from '../bot/handlers/command/topic-store.js';
import { messageSender } from '../telegram/message-sender.js';
import {
  createPendingQuestion,
  buildAskUserMessageText,
  buildAskUserKeyboard,
  buildAskUserExpiredNote,
  closeExpiredQuestion,
  questionTimeoutMinutes,
} from './ask-user.js';
import { parseSessionKey } from '../utils/session-key.js';
import { parseSecretRequest, requestSecret } from './secret-request.js';
import { resolveAskUserArgs, runAskUserForm } from './ask-user-form.js';

// ── Types ────────────────────────────────────────────────────────────

export interface McpToolsContext {
  telegramCtx: Context;
  sessionKey: string;
}

// ── Factory ──────────────────────────────────────────────────────────

export function createTeleCoderMcpServer(
  toolsCtx: McpToolsContext
): McpSdkServerConfigWithInstance {
  const tools = buildToolList(toolsCtx);

  return createSdkMcpServer({
    name: 'telecoder-tools',
    version: '1.0.0',
    tools,
  });
}

function buildToolList(toolsCtx: McpToolsContext) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: SdkMcpToolDefinition<any>[] = [
    listProjectsTool(toolsCtx),
    switchProjectTool(toolsCtx),
    createBotTool(toolsCtx),
    sendFileTool(toolsCtx),
    askUserTool(toolsCtx),
    requestSecretTool(toolsCtx),
  ];

  tools.push(setTopicTool(toolsCtx));

  return tools;
}

// ── Tool Definitions ─────────────────────────────────────────────────

function listProjectsTool(_toolsCtx: McpToolsContext) {
  return tool(
    'telecoder_list_projects',
    'List all available projects in the workspace directory. Use this to see what projects the user can switch to.',
    {},
    async () => {
      try {
        const workspaceRoot = getWorkspaceRoot();
        const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
        const projects = entries
          .filter(e => e.isDirectory() && !e.name.startsWith('.'))
          .map(e => e.name);

        return {
          content: [{
            type: 'text' as const,
            text: `Projects in ${workspaceRoot}:\n${projects.join('\n')}`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error listing projects: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}

function switchProjectTool(toolsCtx: McpToolsContext) {
  return tool(
    'telecoder_switch_project',
    'Switch the working directory to a different project. The change takes effect on the next query. Use telecoder_list_projects first to see available projects.',
    { project_name: z.string().describe('Name of the project directory to switch to') },
    async ({ project_name }) => {
      try {
        const workspaceRoot = getWorkspaceRoot();
        const targetPath = path.resolve(workspaceRoot, project_name);

        if (!isPathWithinRoot(workspaceRoot, targetPath)) {
          return {
            content: [{ type: 'text' as const, text: `Error: Path must be within workspace root: ${workspaceRoot}` }],
            isError: true,
          };
        }

        if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
          return {
            content: [{ type: 'text' as const, text: `Error: Project not found: ${project_name}` }],
            isError: true,
          };
        }

        sessionManager.setWorkingDirectory(toolsCtx.sessionKey, targetPath);
        clearTopic(toolsCtx.sessionKey);

        return {
          content: [{
            type: 'text' as const,
            text: `Switched to project: ${project_name} (${targetPath}). The new working directory will take effect on the next query.`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error switching project: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}

function createBotTool(toolsCtx: McpToolsContext) {
  return tool(
    'telecoder_create_bot',
    "Create a Telegram bot for one project: sends the user a button that opens Telegram's create-a-bot screen. Once they confirm, the new bot is added to the launcher and starts in that project. Use when the user asks for a bot for a project. Only from a private chat, and only for an admin.",
    { project_name: z.string().describe('Project directory name in the workspace, or an absolute path') },
    async ({ project_name }) => {
      try {
        const { offerNewBotForSession } = await import('../bot/handlers/newbot.handler.js');
        const result = await offerNewBotForSession(toolsCtx.telegramCtx.api, toolsCtx.sessionKey, project_name);
        return { content: [{ type: 'text' as const, text: result.message }], ...(result.ok ? {} : { isError: true }) };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error creating bot: ${sanitizeError(error)}` }],
          isError: true,
        };
      }
    }
  );
}

const TELEGRAM_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

function sendFileTool(toolsCtx: McpToolsContext) {
  return tool(
    'telecoder_send_file',
    'Send a file from the server to the user via Telegram. The file must be within the project (or the workspace, for an admin) or /tmp; credential files such as .env or ~/.ssh are never sent. Use this after creating files (SVGs, images, reports, etc.) to deliver them directly to the user. Maximum file size: 50MB.',
    {
      file_path: z.string().describe('Absolute or relative path to the file to send. Relative paths are resolved from the current working directory.'),
      caption: z.string().optional().describe('Optional caption to display with the file in Telegram'),
    },
    async ({ file_path, caption }) => {
      try {
        const ctx = toolsCtx.telegramCtx;
        const session = sessionManager.getSession(toolsCtx.sessionKey);

        if (!session) {
          return {
            content: [{ type: 'text' as const, text: 'Error: No active session.' }],
            isError: true,
          };
        }

        // The same rules as /file (bot/file-access.ts): the credential denylist
        // for everyone, the chat's project for a guest, the workspace for an
        // admin — judged by who sent the message this turn answers. Plus /tmp,
        // where claude drops files it made to send.
        const resolved = resolveSendablePath(file_path, session.workingDirectory, ctx.from?.id);
        if (!resolved.ok) {
          if (resolved.reason === 'sensitive') {
            console.log(`[MCP] send_file REFUSED credential path for user:${ctx.from?.id ?? 'unknown'}`);
          }
          return {
            content: [{ type: 'text' as const, text: sendableRefusalMessage(resolved.reason, file_path, resolved.root) }],
            isError: true,
          };
        }
        const resolvedPath = resolved.path;
        const stat = fs.statSync(resolvedPath);

        if (stat.size > TELEGRAM_MAX_FILE_SIZE) {
          const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
          return {
            content: [{ type: 'text' as const, text: `Error: File too large (${sizeMB}MB). Telegram limit is 50MB.` }],
            isError: true,
          };
        }

        const fileName = path.basename(resolvedPath);
        const fileBuffer = fs.readFileSync(resolvedPath);
        const inputFile = new InputFile(fileBuffer, fileName);

        await ctx.replyWithDocument(inputFile, {
          caption: caption || undefined,
        });

        const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);
        return {
          content: [{
            type: 'text' as const,
            text: `File sent to user: ${fileName} (${sizeMB}MB)`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `File send error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}

function setTopicTool(toolsCtx: McpToolsContext) {
  return tool(
    'telecoder_set_topic',
    'Update the conversation topic shown in the status line and as the thread\'s name. Call this proactively when the work topic changes. Pass an empty string to clear. Keep topics very short (1-4 words).',
    {
      topic: z.string().describe(
        'Short topic label (1-4 words, e.g. "auth refactor", "CI fix", "dark mode"). Empty string to clear.'
      ),
    },
    async ({ topic }) => {
      try {
        const { sessionKey } = toolsCtx;

        // The topic lives in the status line and the thread name, not the
        // Telegram bot display name, which is static: Telegram rate-limits
        // setMyName brutally. Mirrors the /topic command handler.
        const trimmedTopic = topic.trim();
        setSessionTopic(sessionKey, trimmedTopic);

        return {
          content: [{
            type: 'text' as const,
            text: trimmedTopic
              ? `Topic set to "${trimmedTopic}".`
              : 'Topic cleared.',
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Failed to set topic: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );
}

function askUserTool(toolsCtx: McpToolsContext) {
  return tool(
    'telecoder_ask_user',
    'Ask the user a multiple-choice question via a Telegram inline keyboard. Use when you need a clear decision from the user (e.g. picking between approaches, confirming a destructive action, choosing among options) instead of free-text. Pauses the agent loop until the user taps a button or the question times out. Keep the question short and the options crisp — a label of ≤ 25 chars stays on its button; anything longer makes the whole keyboard fall back to lettered buttons (A/B/C) with the full labels listed in the message body. Several questions at once: pass `questions` (2-4) instead of `question`/`options` — they arrive as ONE form the user steps through, can revise, and submits; nothing reaches you before Submit. Never fire separate calls in a row for questions that belong together. IMPORTANT: `context` is required and carries everything the user needs to decide (the comparison, trade-offs, findings, rationale) — it renders in the SAME message as the buttons. Do NOT write that explanation as prose before calling this tool: text you emit before an ask_user call is not delivered to the user until after they answer, so they would be choosing blind.',
    {
      question: z.string().optional().describe('The question to display to the user. Keep concise (1-2 sentences). Required unless `questions` is given.'),
      context: z
        .string()
        .min(1)
        .describe('Required. The multi-line explanation shown above the buttons in the same message (e.g. a comparison table, trade-offs, findings the user needs to make an informed choice). Put decision-relevant detail here, not in prose before the call — that prose is not shown until after the user answers. If the choice genuinely needs no explanation, restate what each option will do.'),
      options: z
        .array(
          z.object({
            label: z.string().describe('Button label. ≤ 25 chars keeps the label on its own button; longer labels are still shown in full in the message body, keyed A/B/C. Keep it to one line either way.'),
            description: z.string().optional().describe('Optional one-line context shown in the question body.'),
          })
        )
        .min(2)
        .max(8)
        .optional()
        .describe('Between 2 and 8 options for the user to choose from. Required unless `questions` is given.'),
      questions: z
        .array(
          z.object({
            question: z.string().min(1).describe('One question, 1-2 sentences.'),
            options: z
              .array(
                z.object({
                  label: z.string().describe('Button label; ≤ 25 chars keeps it on its button.'),
                  description: z.string().optional().describe('Optional one-line note shown in the body.'),
                })
              )
              .min(2)
              .max(8),
          })
        )
        .min(1)
        .max(4)
        .optional()
        .describe('Several related questions as one form, in place of `question`/`options`. The user answers each with buttons, can go back and change any answer, and nothing is sent until they tap Submit — like AskUserQuestion with several questions. 2-4 questions, 2-8 options each; `context` is shown once at the top.'),
    },
    async ({ question: rawQuestion, context, options: rawOptions, questions }) => {
      try {
        const ctx = toolsCtx.telegramCtx;
        if (!ctx?.chat?.id) {
          return {
            content: [{ type: 'text' as const, text: 'Error: no Telegram context available to ask the user.' }],
            isError: true,
          };
        }

        const threadId = parseSessionKey(toolsCtx.sessionKey).threadId;
        const asked = resolveAskUserArgs({ question: rawQuestion, options: rawOptions, questions });
        if (typeof asked === 'string') {
          return { content: [{ type: 'text' as const, text: asked }], isError: true };
        }
        if (asked.form) {
          const text = await runAskUserForm({
            api: ctx.api,
            chatId: ctx.chat.id,
            threadId,
            sessionKey: toolsCtx.sessionKey,
            questions: asked.form,
            context,
            onPosted: () => messageSender.noteQuestionPosted(ctx, toolsCtx.sessionKey),
            onSettled: () => messageSender.noteQuestionAnswered(ctx, toolsCtx.sessionKey),
          });
          return { content: [{ type: 'text' as const, text }] };
        }
        const { question, options } = asked;

        const optionLabels = options.map((o) => o.label);
        const { id, promise } = createPendingQuestion(optionLabels, undefined, toolsCtx.sessionKey);

        const messageText = buildAskUserMessageText(question, options, context);

        const keyboard = buildAskUserKeyboard(id, options);

        // Plain text (no parse_mode): model-supplied question/context/label/
        // description text can contain stray underscores, asterisks, or
        // backticks (e.g. URL params like `f_WT=2`) that break legacy Markdown
        // parsing — Telegram returns 400 and the tool fails with no useful
        // signal to the model. The body lists every option in full, keyed by
        // the letter on its button.
        // From the session key, not `ctx.message` — a turn started by a tapped
        // button carries a callback-query context with no `message`, which
        // would silently drop the thread and post into General.
        const sent = await ctx.api.sendMessage(ctx.chat.id, messageText, {
          reply_markup: { inline_keyboard: keyboard },
          ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
        });
        await messageSender.noteQuestionPosted(ctx, toolsCtx.sessionKey);

        const answer = await promise;
        await messageSender.noteQuestionAnswered(ctx, toolsCtx.sessionKey);
        if (!answer) {
          await closeExpiredQuestion(ctx.api, sent, messageText, buildAskUserExpiredNote());
          return {
            content: [{ type: 'text' as const, text: `User did not respond within ${questionTimeoutMinutes()} minutes. Proceed using your best judgment or ask again.` }],
            isError: false,
          };
        }

        return {
          content: [{ type: 'text' as const, text: `User selected: ${answer.label}` }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Ask-user error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}

/**
 * The SDK side of telecoder_request_secret; secret-request.ts has the flow.
 * The description and fields match src/bin/mcp-server.ts's, which PTY mode
 * registers.
 */
function requestSecretTool(toolsCtx: McpToolsContext) {
  return tool(
    'telecoder_request_secret',
    'Get a secret from the user (an API key, token or password) without it entering this conversation. The user sends it in Telegram; TeleCoder deletes their message at once and runs `command` with the secret in $SECRET and on stdin. You get the exit code and the output with the secret blanked out, never the value. Use this whenever a task needs a credential from the user: never ask them to paste one into the chat, and don\'t send them to a terminal for it. They see the command before they send anything, so make it do exactly what it says. For a long-lived Claude token (CLAUDE_CODE_OAUTH_TOKEN), set source to "claude-setup-token": TeleCoder runs `claude setup-token` on this machine and walks them through signing in, and the token goes straight into your command without passing through Telegram. Works only in a private chat with an admin of the bot. Blocks until the command has run, the user cancels, or the request times out.',
    {
      name: z.string().min(1).max(100).describe('What the secret is, as the user knows it: an env var name like CLAUDE_CODE_OAUTH_TOKEN, or a label like "Stripe test key".'),
      purpose: z.string().min(1).describe('One or two sentences for the user: what it is for, and where to get it.'),
      command: z.string().min(1).describe('Bash that consumes the secret, from $SECRET or from stdin (the secret and a newline). It runs once, with no terminal, and has 2 minutes. Prefer stdin where the tool reads it: an argument shows in the process list while the command runs. Example: npx dotenvx set API_KEY "$SECRET" -f .env'),
      cwd: z.string().optional().describe('Directory to run the command in. Defaults to the session\'s working directory; ~ works.'),
      pattern: z.string().optional().describe('A regular expression the secret has to match, e.g. ^sk-ant-oat01-. A message that doesn\'t match is deleted unused and the user asked again, so a stray reply can\'t end up stored as the secret.'),
      source: z.enum(['paste', 'claude-setup-token']).optional().describe('"paste" (the default): the user sends the secret. "claude-setup-token": TeleCoder makes a long-lived Claude OAuth token by running `claude setup-token` here; the user signs in through a link and sends back the code the page shows. A token they already have is accepted too.'),
    },
    async ({ name, purpose, command, cwd, pattern, source }, extra) => {
      try {
        const req = parseSecretRequest({ name, purpose, command, cwd, pattern, source });
        if (typeof req === 'string') return { content: [{ type: 'text' as const, text: req }], isError: true };
        const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
        const { sessionKey, telegramCtx: ctx } = toolsCtx;
        const result = await requestSecret(
          ctx,
          sessionKey,
          req,
          signal,
          {
            onPosted: () => messageSender.noteQuestionPosted(ctx, sessionKey),
            onSettled: () => messageSender.noteQuestionAnswered(ctx, sessionKey),
          },
        );
        return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Secret request error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}
