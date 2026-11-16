---
title: Voice
description: Send voice notes instead of typing.
sidebar:
  order: 7
---

## Voice notes in

Send a voice note and the bot transcribes it with Groq Whisper, shows you the transcript,
and sends it to Claude as your message.

You need a [Groq API key](https://console.groq.com/keys); Groq has a free tier.
`telecoder init` asks for one, and you can say no: a voice note then
answers with how to turn it on. Run `telecoder init` again (it keeps your other answers
and asks for the key), or add it to `~/.telecoder/.env` and `/restartbot`:

```bash
GROQ_API_KEY=gsk_...
```

- **Language**: English by default. Set `VOICE_LANGUAGE` (for example `nl`) for another.
- **Transcript**: shown before Claude answers. `VOICE_SHOW_TRANSCRIPT=false` hides it.
- **Size**: up to 19MB per note.

Audio files and video aren't sent to Claude: only voice notes become prompts. Every voice
setting is in [Configuration](../reference/configuration.md#voice-notes).
