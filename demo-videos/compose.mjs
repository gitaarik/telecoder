// Combine a run's pane recordings into one video.
//
//   node compose.mjs out/<run> [--cut <fromMs>-<toMs> ...]
//
// The picture is a split screen (see LAYOUT). Reads <run>/log.json: "<pane>:start" marks say when each pane's recording
// began, {video, path} entries say where it is. Times are ms since the run
// started. Cuts remove waiting; a scene script can also log
// { cut: [fromMs, toMs] } entries, which are applied the same way.
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

// Split screen: Telegram on the left, and on the right the terminal or the app,
// whichever the scene last asked for with { show: pane }. The picture is only
// as large as the panes need, so nothing sits in a wide empty margin.
let CANVAS = '1600x1040';
const LAYOUT = { telegram: [20, 20], terminal: [680, 20], app: [680, 20] };
const RIGHT = ['terminal', 'app'];
const BACKGROUND = '0x0b0e13';

const [run, ...rest] = process.argv.slice(2);
if (!run) { console.error('usage: node compose.mjs out/<run> [--cut from-to ...]'); process.exit(1); }
const dir = run.replace(/\/?$/, '/');
const log = JSON.parse(await readFile(dir + 'log.json', 'utf8'));

Object.assign(LAYOUT, ...log.filter((l) => l.layout).map((l) => l.layout));
CANVAS = log.findLast((l) => l.canvas)?.canvas ?? CANVAS;

const starts = Object.fromEntries(
  log.filter((l) => l.what?.endsWith(':start')).map((l) => [l.what.split(':')[0], l.t]),
);
const videos = log.filter((l) => l.video && LAYOUT[l.video]);
const zero = Math.max(...videos.map((v) => starts[v.video])); // the last pane to start

const cuts = log.filter((l) => l.cut).map((l) => l.cut);
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--cut') cuts.push(rest[++i].split('-').map(Number));
}

/** An ffmpeg expression that is true while a right-hand pane is the one on show. */
function shown(pane) {
  const shows = log.filter((l) => l.show).sort((a, b) => a.t - b.t);
  const spans = shows.flatMap((l, i) => l.show === pane
    ? [`between(t,${i === 0 ? 0 : ((l.t - zero) / 1000).toFixed(3)},${shows[i + 1] ? ((shows[i + 1].t - zero) / 1000 - 0.001).toFixed(3) : 1e9})`]
    : []);
  return spans.length ? spans.join('+') : '0';
}

const inputs = ['-f', 'lavfi', '-i', `color=c=${BACKGROUND}:s=${CANVAS}:r=25`];
const chain = [];
let prev = '0';
videos.forEach((v, i) => {
  inputs.push('-ss', ((zero - starts[v.video]) / 1000).toFixed(3), '-i', v.path);
  const [x, y] = LAYOUT[v.video];
  const last = i === videos.length - 1;
  const when = RIGHT.includes(v.video) ? `:enable='${shown(v.video)}'` : '';
  chain.push(`[${prev}][${i + 1}]overlay=${x}:${y}${last ? ':shortest=1' : ''}${when}[o${i}]`);
  prev = `o${i}`;
});
// Telegram Web redraws the whole chat when a message arrives: for up to a
// second the list goes blank and jumps about. Hold the last steady picture
// over each such burst, so the new state arrives as one clean change.
const tg = videos.find((v) => v.video === 'telegram');
if (tg && !process.env.NO_STEADY) {
  const offset = (zero - starts.telegram) / 1000;
  const [x, y] = LAYOUT.telegram;
  // In the wide layout the chat is only the right part of the pane, and its redraws are a
  // small share of the picture: look at the chat alone, and count smaller changes.
  const wide = CANVAS.startsWith('1920');
  const bursts = unsteady(tg.path, wide ? 'crop=564:1000:376:0,' : '', Number(process.env.STEADY_MIN ?? (wide ? 0.004 : 0.02)));
  console.error(`steadied ${bursts.length} bursts, ${bursts.reduce((n, [a, b]) => n + b - a, 0).toFixed(1)} s`);
  for (const [n, [a, b]] of bursts.filter(([, b]) => b > offset).entries()) {
    const still = `${dir}steady-${n}.png`;
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', Math.max(0, a - 0.08).toFixed(3), '-i', tg.path, '-frames:v', '1', still]);
    inputs.push('-i', still); // one frame, which the overlay keeps showing
    const from = (a - 0.04 - offset).toFixed(3);
    const to = (b + 0.02 - offset).toFixed(3); // through the burst's last frame: the settled picture follows
    chain.push(`[${prev}][${inputs.filter((i) => i === '-i').length - 1}]overlay=${x}:${y}:enable='between(t,${from},${to})'[s${n}]`);
    prev = `s${n}`;
  }
}

if (cuts.length) {
  const between = cuts
    .map(([a, b]) => `between(t,${((a - zero) / 1000).toFixed(3)},${((b - zero) / 1000).toFixed(3)})`)
    .join('+');
  chain.push(`[${prev}]select='not(${between})',setpts=N/FRAME_RATE/TB[cut]`);
  prev = 'cut';
}

const out = dir + 'video.mp4';
const r = spawnSync(
  'ffmpeg',
  ['-v', 'error', '-y', ...inputs, '-filter_complex', chain.join(';'), '-map', `[${prev}]`,
   '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out],
  { stdio: 'inherit' },
);
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(out);

/**
 * Bursts of redrawing in a recording: [from, to] in seconds of the file's own
 * time. A burst is two or more large frame-to-frame changes within half a
 * second of each other. One large change alone is a message arriving, and typing
 * or streaming text changes far too little to count.
 */
function unsteady(file, crop = '', min = 0.02) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf',
    crop + "select='gte(scene,0)',metadata=print:key=lavfi.scene_score:file=-", '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 1 << 28 });
  const changes = [];
  let t = 0;
  for (const line of r.stdout.split('\n')) {
    const time = line.match(/pts_time:([\d.]+)/);
    if (time) t = Number(time[1]);
    const score = line.match(/scene_score=([\d.]+)/);
    if (score && Number(score[1]) > min) changes.push(t);
  }
  const bursts = [];
  for (const c of changes) {
    const last = bursts.at(-1);
    if (last && c - last.at(-1) < 0.6) last.push(c);
    else bursts.push([c]);
  }
  return bursts.filter((b) => b.length > 1 && b.at(-1) - b[0] < 2.5).map((b) => [b[0], b.at(-1)]);
}
