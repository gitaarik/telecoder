import { PtyProvider } from '../claude/pty-provider.js';
import type { Provider } from './types.js';

// Claude Code runs in a pty: the real `claude` CLI, driven in a pseudo-terminal
// with its dialogs relayed to the chat. The one instance is shared with the
// CCR provider, which runs the same pty around CCR's wrapper script.
const ptyProvider = new PtyProvider();

export function getPtyProvider(): PtyProvider {
  return ptyProvider;
}

export const claudeProvider: Provider = ptyProvider;
