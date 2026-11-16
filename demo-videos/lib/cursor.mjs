// A visible mouse pointer for the recordings. Headless browsers draw none, so
// each page gets a drawn one that follows the real mouse position, and clicks
// travel there at a human pace first.

/** Runs in the page (context.addInitScript): draws the pointer, plus any extra CSS. */
export function installCursor(css = '') {
  // Hovering a link makes the browser show its address in a corner of the window, and
  // the recording picks that up. So a link has no address while the pointer rests on it.
  if (!window.__demoLinks) {
    window.__demoLinks = true;
    addEventListener('mouseover', (e) => {
      const a = e.target?.closest?.('a[href]');
      if (!a) return;
      a.dataset.demoHref = a.getAttribute('href');
      a.removeAttribute('href');
    }, true);
    // A link can also end up under a resting pointer without a mouseover: the page
    // scrolls, or is loaded again. So take them all, regularly.
    setInterval(() => {
      for (const a of document.querySelectorAll('a[href]')) {
        a.dataset.demoHref = a.getAttribute('href');
        a.removeAttribute('href');
      }
    }, 300);
    // Telegram Web's own links (the chat list) work without their address. In an
    // embedded page (BotFather's Mini App) a link is how one gets around, so a click
    // on one goes where its address pointed. Putting the address back for the click
    // instead would bring the pop-up back with it.
    addEventListener('click', (e) => {
      if (window.top === window) return;
      const a = e.target?.closest?.('a[data-demo-href]');
      if (!a || a.hasAttribute('href') || a.target === '_blank') return;
      e.preventDefault();
      e.stopImmediatePropagation(); // the page's own handler would read an empty address
      location.assign(new URL(a.dataset.demoHref, location.href).href);
    }, true);
  }
  const setup = () => {
    if (window.top !== window || document.getElementById('demo-cursor')) return;
    const style = document.createElement('style');
    style.textContent = `
      #demo-cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none;
        width: 26px; height: 26px; opacity: 0; transition: opacity .25s; will-change: transform; }
      #demo-cursor.on { opacity: 1; }
      #demo-cursor.down svg { transform: scale(.86); }
      #demo-cursor svg { transition: transform .08s; transform-origin: 4px 3px; }
      ${css}`;
    document.documentElement.appendChild(style);
    const el = document.createElement('div');
    el.id = 'demo-cursor';
    el.innerHTML = '<svg width="26" height="26" viewBox="0 0 26 26"><path d="M4 3 L4 21 L9 16.5 L12.3 23.5 L15.2 22.2 L12 15.3 L18.5 15.3 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(el);
    const move = (e) => { el.classList.add('on'); el.style.transform = `translate(${e.clientX - 4}px, ${e.clientY - 3}px)`; };
    addEventListener('mousemove', move, true);
    addEventListener('mousedown', () => el.classList.add('down'), true);
    addEventListener('mouseup', () => el.classList.remove('down'), true);
  };
  if (document.documentElement) setup();
  addEventListener('DOMContentLoaded', setup);
}

const where = new WeakMap(); // page -> last pointer position

/** Move the pointer to the middle of an element, easing in and out like a hand does. */
export async function glide(page, locator, { ms } = {}) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const box = await locator.boundingBox();
  if (!box) throw new Error('Nothing to point at');
  const size = page.viewportSize();
  const from = where.get(page) ?? { x: size.width * 0.55, y: size.height * 0.6 };
  const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  // A quick, deliberate hand: short hops take a quarter second, a cross-screen
  // move about three quarters. Paced by the clock, not by step count, because each
  // frame also pays a page.evaluate round trip.
  const duration = ms ?? Math.min(750, 220 + distance * 0.7);
  const started = Date.now();
  for (;;) {
    const p = Math.min(1, (Date.now() - started) / duration);
    const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2; // ease in-out
    // A slight arc, so the path isn't ruler-straight.
    const arc = Math.sin(Math.PI * p) * Math.min(18, distance * 0.06);
    const x = from.x + (to.x - from.x) * e;
    const y = from.y + (to.y - from.y) * e - arc;
    await page.mouse.move(x, y);
    // Over an embedded page (BotFather's Mini App) the outer page hears no mouse moves,
    // so place the drawn pointer directly as well.
    await page.evaluate(([x, y]) => {
      const el = document.getElementById('demo-cursor');
      if (el) { el.classList.add('on'); el.style.transform = `translate(${x - 4}px, ${y - 3}px)`; }
    }, [x, y]).catch(() => {});
    if (p >= 1) break;
    await page.waitForTimeout(16);
  }
  where.set(page, to);
}

/** Glide to an element, rest a moment, and click it. */
export async function pointAndClick(page, locator, opts) {
  await glide(page, locator, opts);
  await page.waitForTimeout(200);
  const press = (on) => page.evaluate((on) => document.getElementById('demo-cursor')?.classList.toggle('down', on), on).catch(() => {});
  await page.mouse.down();
  await press(true);
  await page.waitForTimeout(90);
  await page.mouse.up();
  await press(false);
}
