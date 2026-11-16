# Scene 1: setup

**Shows:** from nothing to a first conversation, in under two minutes.
**Right pane:** terminal, the whole time.
**Telegram pane:** wide, so the chat list and later the threads sit left of the chat.
**Starts from:** a machine without TeleCoder, and a Telegram account with no bot.

## Beats

1. **BotFather.** Alex sends `/newbot`, gives the name "TeleCoder" and a username like
   `alex_mealplan_bot`. BotFather answers with the token, in full view:
   people should see what a token looks like. The bot is deleted after the take.
2. **Install.** In the terminal: `npm install -g telecoder`. The wait is cut.
3. **Wizard.** `telecoder init`. It checks Node and Claude, then asks for the token
   (typed hidden).
4. **Who owns it.** The wizard waits. Alex opens the new bot in Telegram and sends
   `/start`. The wizard shows the account and Alex confirms.
5. **The other questions.** SDK or PTY is answered with PTY, the real Claude Code in a
   terminal, which beat 10 shows. The rest get their default: projects folder, voice.
   Every answer is typed out (`y`, `n` or the number) and stays up a moment before
   Enter, so the viewer sees what was answered.
6. **The icon.** The wizard offers the TeleCoder icon as the bot's picture. Yes.
   The bot then shows its new picture in the chat list and the chat's header.
7. **Service.** The wizard offers to keep the bot running in the background. Yes.
8. **BotFather's Mini App.** Alex clicks BotFather in the chat list, then Open, picks
   the bot, opens Bot Settings and turns on Bot Management Mode and Threaded Mode.
   The Mini App blurs the token by itself.
9. **Restart.** In the terminal: `telecoder service restart`, so the bot reads the new
   setting. The wait is cut.
10. **Watch.** In the terminal: `telecoder watch`. It waits for a Claude Code session.
    The terminal's text is smaller from here on, because Claude Code's screen is 120
    columns wide. The change of size happens inside the cut of beat 9.
11. **Pick the project.** Back in the bot, the threads are now a column on the left.
    `/project mealplan` opens as its own thread.
12. **First question.** "What does this project do?" On the right the question appears
    in the real Claude Code, and Claude works on it there while the answer arrives in
    Telegram. This is the point of the video's ending: TeleCoder is a front end for
    Claude Code. Up to 15 s of Claude working stays in; the rest of the wait is cut. End.

## Checks

- The wizard finishes within five minutes.
- A reply with a status line arrives after the question.
- Both switches are on in BotFather.
- `telecoder watch` shows Claude Code's screen after the question is sent.

## Afterwards

The bot made on camera is deleted, so the token shown is dead. The demo machine gets
its real setup back.
