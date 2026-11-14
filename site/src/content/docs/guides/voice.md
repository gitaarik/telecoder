---
title: Voice
description: Send voice notes instead of typing, and have replies read back to you.
sidebar:
  order: 7
---

## Voice notes in

Send a voice note and the bot transcribes it with Groq Whisper, shows you the transcript,
and sends it to Claude as your message.

You need a [Groq API key](https://console.groq.com/keys); Groq has a free tier.
`telecoder init` asks for one, or add it to `~/.telecoder/.env`:

```bash
GROQ_API_KEY=gsk_...
```

- **Language**: English by default. Set `VOICE_LANGUAGE` (for example `nl`) for another.
- **Transcript**: shown before Claude answers. `VOICE_SHOW_TRANSCRIPT=false` hides it.
- **Size**: up to 19MB per note.

`/transcribe` transcribes without sending anything to Claude: send it as a reply to a voice
note or audio file. Audio files and video aren't sent to Claude on their own.

## Spoken replies out

`/tts` turns on spoken replies for the chat or thread you're in. Each reply then also
arrives as a voice note, without its code blocks. The menu picks the voice, and whether it
comes as a voice note that plays straight away or as an audio file.

Two providers:

- **Groq Orpheus**, the default. It uses the same `GROQ_API_KEY`, and needs `ffmpeg` on the
  machine.
- **OpenAI**: set `TTS_PROVIDER=openai` and `OPENAI_API_KEY`. `TTS_MODEL`, `TTS_SPEED` and
  `TTS_INSTRUCTIONS` tune it.

Replies longer than `TTS_MAX_CHARS` (4096) are cut at the end of a sentence. Every voice
setting is in [Configuration](../reference/configuration.md#voice-and-tts).
