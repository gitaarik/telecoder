# Interface Facts for Pty Automation

This document contains stable interface facts mined from the `claude` CLI binary. These are used to build the pty parser and automation logic.

## Key Glyphs

- **Input Prompt**: `❯`
  - This character signals that the REPL is idle and waiting for user input.
  - Often preceded by ANSI color codes (e.g., `[36m` for cyan).
- **Assistant Message**: `●`
  - This character prefixes all of Claude's responses. It's the primary signal to look for to begin capturing a response.

## Spinners

- The CLI uses braille patterns and other Unicode characters for its spinners. The exact patterns are not critical, as the `@xterm/headless` parser will correctly handle them overwriting themselves. The key is that their presence indicates a work-in-progress state.

## Dialogs

- **Permission Prompts**: The text "Allow this tool to run?" is a key string for detecting when Claude is asking for permission to execute a tool.
- **Folder Trust**: The text "Do you trust this folder?" is the signal for the one-time folder trust dialog. The automation should handle this by starting in a trusted directory.

## End-of-turn

- The most reliable end-of-turn signal is the re-appearance of the input prompt `❯` at the end of the output, combined with a period of stdout inactivity.

