// Set the demo bot's profile picture through the Bot API. The token is read from
// .session/bot-token and only ever used in-process.
import { readFile } from 'node:fs/promises';
const token = (await readFile(new URL('./.session/bot-token', import.meta.url), 'utf8')).trim();
const jpg = await readFile(new URL('./assets/botpic.jpg', import.meta.url));
const form = new FormData();
form.set('photo', JSON.stringify({ type: 'static', photo: 'attach://pic' }));
form.set('pic', new Blob([jpg], { type: 'image/jpeg' }), 'botpic.jpg');
const res = await fetch(`https://api.telegram.org/bot${token}/setMyProfilePhoto`, { method: 'POST', body: form })
  .then((r) => r.json()).catch((e) => ({ ok: false, description: String(e.message).replaceAll(token, '<token>') }));
console.log(JSON.stringify(res));
process.exit(res.ok ? 0 : 1);
