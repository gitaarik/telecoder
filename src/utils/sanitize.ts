import * as os from 'os';

const HOME_DIR = os.homedir();
let USERNAME = '';
try { USERNAME = os.userInfo().username; } catch { USERNAME = ''; }

/**
 * Sanitize a string by replacing sensitive paths and usernames.
 * Useful for error messages and logs to prevent information leakage.
 */
export function sanitizePath(str: string): string {
  if (!str) return str;

  let sanitized = str;

  // Replace home directory with ~
  if (HOME_DIR) {
    sanitized = sanitized.replace(new RegExp(escapeRegExp(HOME_DIR), 'g'), '~');
  }

  // Replace username if it appears in paths
  if (USERNAME && USERNAME.length > 2) {
    // Only replace in path-like contexts to avoid false positives
    sanitized = sanitized.replace(
      new RegExp(`/Users/${escapeRegExp(USERNAME)}`, 'g'),
      '/Users/<user>'
    );
    sanitized = sanitized.replace(
      new RegExp(`/home/${escapeRegExp(USERNAME)}`, 'g'),
      '/home/<user>'
    );
  }

  return sanitized;
}

/**
 * Secrets that turn up in error messages: a failed request echoes its URL, a
 * failed command echoes its arguments. Each pattern keeps enough context
 * (a `bot` prefix, a key name) to say what was there, and drops the value.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Telegram bot token, bare or as the `bot<token>` path segment of an API URL.
  [/\d{6,}:[A-Za-z0-9_-]{30,}/g, '<telegram-token>'],
  // Anthropic, OpenAI and similar `sk-` keys.
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, '<api-key>'],
  // GitHub tokens.
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, '<github-token>'],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, '<github-token>'],
  // Slack, AWS and Google API keys.
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '<slack-token>'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '<aws-key>'],
  [/\bAIza[0-9A-Za-z_-]{35}/g, '<google-key>'],
  // Authorization headers.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 <redacted>'],
  // Credentials in a URL: scheme://user:password@host
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1<redacted>@'],
  // key=value and key: value pairs whose key names a secret.
  [
    /\b([A-Za-z0-9_]*(?:token(?!s)|secret|password|passwd|api[_-]?key|access[_-]?key)[A-Za-z0-9_]*)(["']?\s*[=:]\s*["']?)[^\s"'&,;]{6,}/gi,
    '$1$2<redacted>',
  ],
];

/**
 * Replace tokens, API keys and credentials in a string with placeholders.
 * Applied by sanitizeError; use directly on anything else headed for a chat
 * or a log that might contain a URL or command line.
 */
export function redactSecrets(str: string): string {
  if (!str) return str;
  let out = str;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Extract and sanitize an error message for user-facing display.
 * Returns a sanitized message string with secrets and sensitive paths removed.
 * Note: Does not sanitize stack traces — avoid logging raw error objects to users.
 */
export function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    return sanitizePath(redactSecrets(error.message));
  }
  if (typeof error === 'string') {
    return sanitizePath(redactSecrets(error));
  }
  return 'Unknown error';
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
