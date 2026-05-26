/**
 * Shared parsing helpers for `instances.json`. Used by both the launcher
 * (resolving instances to spawn) and worker-side enumeration (listing
 * sibling bots for /fork). The two files have different output shapes so
 * they each parse independently — only the tiny utility functions are
 * shared here.
 */

/** Strip full-line `//` comments so we can JSON.parse a commented config. */
export function stripJsonComments(text: string): string {
  return text.replace(/^\s*\/\/.*$/gm, '');
}

function padNumber(n: number, total: number): string {
  const digits = String(total).length;
  return String(n).padStart(digits, '0');
}

/** Substitute `{n}` / `{N}` placeholders in a name template. */
export function expandName(template: string, index: number, total: number): string {
  return template.replace(/\{n\}/g, String(index)).replace(/\{N\}/g, padNumber(index, total));
}
