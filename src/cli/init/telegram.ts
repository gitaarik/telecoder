/**
 * The handful of Bot API calls `telecoder init` makes, over plain fetch.
 *
 * Not grammY: the wizard needs a handful of methods, wants to own the long poll (so
 * Ctrl+C can cancel it), and must never let the token reach a log line — every
 * error leaving this module has been through redactSecrets, and the token
 * itself is replaced too, in case Telegram ever changes its shape.
 *
 * TELECODER_TELEGRAM_API_ROOT points the calls at another server. It exists for
 * tests and for trying the wizard against a fake Telegram; the bot doesn't read
 * it, and nothing else should set it.
 */

import { redactSecrets } from '../../utils/sanitize.js';

export const DEFAULT_API_ROOT = 'https://api.telegram.org';

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date?: number;
    text?: string;
    from?: TgUser;
    chat: { id: number; type: string };
  };
}

export interface TgEntity {
  type: 'code' | 'bold';
  /** In UTF-16 code units, as Telegram counts. */
  offset: number;
  length: number;
}

export interface TgWebhookInfo {
  url: string;
  pending_update_count?: number;
}

/** Telegram answered, with ok: false. */
export class TelegramApiError extends Error {
  constructor(readonly method: string, readonly code: number, readonly description: string) {
    super(`${method} failed (${code}: ${description})`);
    this.name = 'TelegramApiError';
  }
}

/** Telegram couldn't be reached at all. The message is already redacted. */
export class TelegramNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramNetworkError';
  }
}

export interface TelegramClient {
  getMe(): Promise<TgUser>;
  getWebhookInfo(): Promise<TgWebhookInfo>;
  deleteWebhook(): Promise<void>;
  getUpdates(params: { offset?: number; timeout?: number; signal?: AbortSignal }): Promise<TgUpdate[]>;
  /** Plain text plus entities, like every message the bot sends (no parse mode). */
  sendMessage(chatId: number, text: string, entities?: TgEntity[]): Promise<void>;
  /** Whether a user (here: the bot itself) has a profile picture. */
  hasProfilePhoto(userId: number): Promise<boolean>;
  /** Set the bot's own profile picture, from a JPEG. */
  setProfilePhoto(jpeg: Uint8Array, filename: string): Promise<void>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function createTelegramClient(
  token: string,
  { apiRoot = DEFAULT_API_ROOT, fetchImpl = fetch }: { apiRoot?: string; fetchImpl?: FetchLike } = {},
): TelegramClient {
  const base = `${apiRoot.replace(/\/+$/, '')}/bot${token}`;
  const scrub = (text: string) => redactSecrets(text.replaceAll(token, '<token>'));

  /** `params` as JSON, or a FormData when the call uploads a file. */
  async function call<T>(method: string, params: Record<string, unknown> | FormData = {}, signal?: AbortSignal, timeoutMs = 15_000): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(`${base}/${method}`, {
        method: 'POST',
        // fetch writes a FormData's own content-type, boundary included.
        ...(params instanceof FormData
          ? { body: params }
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw new TelegramNetworkError(scrub(describeFetchError(error)));
    }
    let body: { ok?: boolean; result?: T; error_code?: number; description?: string };
    try {
      body = await res.json() as typeof body;
    } catch {
      throw new TelegramApiError(method, res.status, scrub(`HTTP ${res.status}, not a Bot API answer`));
    }
    if (!body.ok) {
      throw new TelegramApiError(method, body.error_code ?? res.status, scrub(body.description ?? `HTTP ${res.status}`));
    }
    return body.result as T;
  }

  return {
    getMe: () => call<TgUser>('getMe'),
    getWebhookInfo: () => call<TgWebhookInfo>('getWebhookInfo'),
    deleteWebhook: async () => { await call<boolean>('deleteWebhook'); },
    // No allowed_updates: Telegram remembers it for the bot, and a narrow list
    // here would quietly stop the bot getting button presses later.
    getUpdates: ({ offset, timeout = 0, signal }) =>
      call<TgUpdate[]>('getUpdates', { offset, timeout }, signal, (timeout + 15) * 1000),
    sendMessage: async (chatId, text, entities) => {
      await call('sendMessage', { chat_id: chatId, text, ...(entities ? { entities } : {}) });
    },
    hasProfilePhoto: async (userId) => {
      const photos = await call<{ total_count: number }>('getUserProfilePhotos', { user_id: userId, limit: 1 });
      return photos.total_count > 0;
    },
    setProfilePhoto: async (jpeg, filename) => {
      const form = new FormData();
      form.set('photo', JSON.stringify({ type: 'static', photo: 'attach://picture' }));
      form.set('picture', new Blob([jpeg], { type: 'image/jpeg' }), filename);
      await call<boolean>('setMyProfilePhoto', form, undefined, 30_000);
    },
  };
}

/** "fetch failed" says nothing; its cause (ENOTFOUND, ECONNREFUSED…) does. */
function describeFetchError(error: unknown): string {
  let current: unknown = error;
  let best = error instanceof Error ? error.message : String(error);
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    if (current.message) best = current.message;
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && !best.includes(code)) best = `${best} (${code})`;
    current = (current as { cause?: unknown }).cause;
  }
  if (error instanceof Error && error.name === 'TimeoutError') return 'timed out';
  return best;
}
