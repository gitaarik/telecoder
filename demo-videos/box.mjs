#!/usr/bin/env node
// A temporary Hetzner box that runs the recording browsers.
//
// The machine the demo bot lives on is short of memory, and a browser that is
// swapping shows Telegram Web's half-drawn states for several frames. So the
// browsers can run on a rented box instead: the scene script stays here, with
// the bot, the demo project and the terminal, and drives the box's browsers
// through an ssh tunnel. The videos come back over the same connection.
//
//   node box.mjs up        rent the box, install the browser, open the tunnel
//   node box.mjs status    is one up, and what has it cost
//   node box.mjs env       the variable a scene needs to use it
//   node box.mjs down      delete it
//
//   node box.mjs up && DEMO_BOX=1 node scenes/setup.mjs; node box.mjs down
//
// The Hetzner project is shared with production servers, so everything made
// here carries the label telecoder=demo-videos and nothing without it is ever
// changed or deleted. The firewall admits ssh from this host only; the browser
// server on the box listens on its loopback and is reached through the tunnel.
// The Telegram login travels as a storage state inside that connection and is
// never written to the box's disk.

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';

const SESSION = new URL('./.session/', import.meta.url).pathname;
const CONF = SESSION + 'box/';
const KEY = CONF + 'id_ed25519';
const KNOWN_HOSTS = CONF + 'known_hosts';
const CONTROL = CONF + 'cm.sock';
const TOKEN_FILE = process.env.HCLOUD_ENV_FILE ?? homedir() + '/.config/tools/hcloud.env';

const LABEL = 'telecoder=demo-videos';
const NAME = 'telecoder-demo-videos';
const LOCATION = 'hel1'; // where this host is, so the tunnel is short
// Dedicated cores first: a recording wants even frame times, and a shared core is someone else's too.
const TYPES = ['ccx23', 'cpx42', 'cpx41'];
const IMAGE = 'ubuntu-24.04';
const PLAYWRIGHT = JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).dependencies['playwright-core'];

/** The browser server on the box, and the two things here its pages load. */
export const PORTS = { browser: 39417, terminal: 47001, app: 4321 };
export const WS = `ws://127.0.0.1:${PORTS.browser}/demo`;

// The same fonts as this host has, so a take from the box looks like one from here.
const CLOUD_INIT = `#cloud-config
package_update: true
ssh_pwauth: false
runcmd:
  - 'systemctl disable --now apt-daily.timer apt-daily-upgrade.timer unattended-upgrades || true'
  - 'DEBIAN_FRONTEND=noninteractive apt-get install -yq -o DPkg::Lock::Timeout=300 curl fonts-dejavu-core fonts-dejavu-extra fonts-dejavu-mono fonts-droid-fallback fonts-liberation fonts-noto-mono fonts-urw-base35'
  - 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && DEBIAN_FRONTEND=noninteractive apt-get install -yq -o DPkg::Lock::Timeout=300 nodejs'
  - 'mkdir -p /root/pw && cd /root/pw && npm init -y >/dev/null && npm install playwright-core@${PLAYWRIGHT} && npx playwright-core install --with-deps firefox'
  - 'touch /root/ready'
`;

const SERVER_SCRIPT = `
import { firefox } from 'playwright-core';
const server = await firefox.launchServer({ headless: true, host: '127.0.0.1', port: ${PORTS.browser}, wsPath: 'demo' });
console.log('listening', server.wsEndpoint());
`;

const log = (msg) => console.error('[box] ' + msg);
const fail = (msg) => { console.error('[box] ' + msg); process.exit(1); };

function token() {
  if (process.env.HCLOUD_TOKEN) return process.env.HCLOUD_TOKEN;
  if (!existsSync(TOKEN_FILE)) fail(`no Hetzner token: ${TOKEN_FILE} is missing`);
  if (statSync(TOKEN_FILE).mode & 0o077) fail(`${TOKEN_FILE} is readable by others`);
  for (const line of readFileSync(TOKEN_FILE, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?HCLOUD_TOKEN=(.+)$/.exec(line);
    if (m) return m[1].trim().replace(/^['"]|['"]$/g, '');
  }
  fail(`${TOKEN_FILE} has no HCLOUD_TOKEN line`);
}

/** The token only ever reaches hcloud through its environment. */
function hcloud(args, { check = true, timeout = 180_000 } = {}) {
  const r = spawnSync('hcloud', args, { env: { ...process.env, HCLOUD_TOKEN: token() }, encoding: 'utf8', timeout });
  if (check && r.status !== 0) throw new Error(`hcloud ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`);
  return r;
}
const hcloudJson = (args, opts) => JSON.parse(hcloud([...args, '-o', 'json'], opts).stdout || 'null');

const [labelKey, labelValue] = LABEL.split('=');
const owned = (resource) => resource?.labels?.[labelKey] === labelValue;
const boxes = () => (hcloudJson(['server', 'list', '--selector', LABEL]) ?? []).filter(owned);
const ipOf = (server) => server.public_net?.ipv4?.ip;

const sshOpts = () => [
  '-i', KEY, '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`, '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', '-o', 'LogLevel=ERROR',
];
const ssh = (ip, command, { input, timeout = 60_000 } = {}) =>
  spawnSync('ssh', [...sshOpts(), `root@${ip}`, command], { input, encoding: 'utf8', timeout });

/** This host's public addresses: all the firewall lets in. */
function sources() {
  const found = [];
  for (const [target, bits] of [['1.1.1.1', 32], ['2606:4700:4700::1111', 128]]) {
    try {
      const src = JSON.parse(execFileSync('ip', ['-j', 'route', 'get', target], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))[0].prefsrc;
      if (src && !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|f[cd]|fe80)/i.test(src)) found.push(`${src}/${bits}`);
    } catch { /* no route of that family */ }
  }
  if (!found.length) fail('this host has no public address of its own');
  return found;
}

function ensureKey() {
  mkdirSync(CONF, { recursive: true, mode: 0o700 });
  chmodSync(CONF, 0o700);
  if (!existsSync(KEY)) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', NAME, '-f', KEY]);
  const existing = (hcloudJson(['ssh-key', 'list']) ?? []).find((k) => k.name === NAME);
  const mine = readFileSync(KEY + '.pub', 'utf8').split(' ').slice(0, 2).join(' ');
  if (existing && !owned(existing)) fail(`an ssh key named ${NAME} exists in the project and is not ours`);
  if (existing && existing.public_key.split(' ').slice(0, 2).join(' ') !== mine) {
    hcloud(['ssh-key', 'delete', String(existing.id)]);
  } else if (existing) return;
  hcloud(['ssh-key', 'create', '--name', NAME, '--public-key-from-file', KEY + '.pub', '--label', LABEL]);
}

function ensureFirewall() {
  const from = sources();
  const rules = [
    { direction: 'in', protocol: 'tcp', port: '22', source_ips: from, description: 'ssh from the machine running box.mjs' },
    { direction: 'in', protocol: 'icmp', source_ips: from },
  ];
  const file = CONF + 'firewall.json';
  writeFileSync(file, JSON.stringify(rules));
  const existing = (hcloudJson(['firewall', 'list']) ?? []).find((f) => f.name === NAME);
  if (existing && !owned(existing)) fail(`a firewall named ${NAME} exists in the project and is not ours`);
  if (existing) hcloud(['firewall', 'replace-rules', String(existing.id), '--rules-file', file]);
  else hcloud(['firewall', 'create', '--name', NAME, '--rules-file', file, '--label', LABEL]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, seconds, check) {
  const end = Date.now() + seconds * 1000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`${what} did not happen within ${seconds}s`);
    await sleep(5000);
  }
}

function tunnelUp() {
  return spawnSync('ssh', ['-S', CONTROL, '-O', 'check', 'box'], { encoding: 'utf8' }).status === 0;
}

function openTunnel(ip) {
  if (tunnelUp()) return;
  rmSync(CONTROL, { force: true });
  // -L: the browser server. -R: what the box's pages load from this host.
  const r = spawnSync('ssh', [
    ...sshOpts(), '-M', '-S', CONTROL, '-f', '-N', '-o', 'ExitOnForwardFailure=yes',
    '-L', `127.0.0.1:${PORTS.browser}:127.0.0.1:${PORTS.browser}`,
    '-R', `127.0.0.1:${PORTS.terminal}:127.0.0.1:${PORTS.terminal}`,
    '-R', `127.0.0.1:${PORTS.app}:127.0.0.1:${PORTS.app}`,
    `root@${ip}`,
  ], { encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) throw new Error('the tunnel did not open: ' + (r.stderr || '').trim());
}

function closeTunnel() {
  spawnSync('ssh', ['-S', CONTROL, '-O', 'exit', 'box'], { encoding: 'utf8' });
  rmSync(CONTROL, { force: true });
}

function cost(server) {
  const hours = (Date.now() - Date.parse(server.created)) / 3600e3;
  const price = server.server_type?.prices?.find((p) => p.location === server.datacenter?.location?.name)?.price_hourly?.gross;
  const up = hours < 1 ? `${Math.round(hours * 60)} min` : `${hours.toFixed(1)} h`;
  return `up ${up}` + (price ? `, about €${(Math.max(1, Math.ceil(hours)) * Number(price)).toFixed(2)} so far (€${Number(price).toFixed(3)}/h, billed per started hour)` : '');
}

async function up() {
  let server = boxes()[0];
  if (!server) {
    ensureKey();
    ensureFirewall();
    const userData = CONF + 'cloud-init.yaml';
    writeFileSync(userData, CLOUD_INIT);
    for (const type of process.env.BOX_TYPE ? [process.env.BOX_TYPE] : TYPES) {
      log(`creating ${NAME}: ${type} in ${LOCATION}`);
      const r = hcloud(['server', 'create', '--name', NAME, '--type', type, '--image', IMAGE, '--location', LOCATION,
        '--ssh-key', NAME, '--firewall', NAME, '--user-data-from-file', userData, '--label', LABEL, '-o', 'json'], { check: false, timeout: 600_000 });
      if (r.status === 0) { server = JSON.parse(r.stdout).server; break; }
      if (!/limit_exceeded|resource_unavailable|unavailable/.test(r.stderr + r.stdout)) throw new Error((r.stderr || r.stdout).trim());
      log(`${type} refused: ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
    }
    if (!server) fail('every server type was refused');
    // The address is one Hetzner hands out again: forget whoever had it before.
    spawnSync('ssh-keygen', ['-q', '-R', ipOf(server), '-f', KNOWN_HOSTS], { stdio: 'ignore' });
  } else {
    log(`a box is already up (${cost(server)})`);
  }
  const ip = ipOf(server);
  try {
    await waitFor('ssh', 300, () => ssh(ip, 'true', { timeout: 20_000 }).status === 0);
    log('installing node and the browser (a few minutes on a new box)');
    await waitFor('the install', 900, () => ssh(ip, 'test -f /root/ready').status === 0);
    const running = ssh(ip, `ss -ltnH 'sport = :${PORTS.browser}' | grep -q .`).status === 0;
    if (!running) {
      ssh(ip, 'cat > /root/pw/server.mjs', { input: SERVER_SCRIPT });
      ssh(ip, 'cd /root/pw && (setsid nohup node server.mjs > server.log 2>&1 &) ; sleep 1');
      await waitFor('the browser server', 60, () => ssh(ip, 'grep -q listening /root/pw/server.log').status === 0);
    }
    openTunnel(ip);
  } catch (error) {
    log(error.message);
    log('the box is still up; "node box.mjs down" deletes it');
    process.exit(1);
  }
  log(`ready: ${cost(boxes()[0] ?? server)}. Run a scene with DEMO_BOX=1.`);
}

function down() {
  closeTunnel();
  const all = boxes();
  for (const server of all) {
    log(`deleting ${server.name} (${cost(server)})`);
    hcloud(['server', 'delete', String(server.id)], { timeout: 300_000 });
  }
  if (!all.length) log('no box is up');
}

function status() {
  const all = boxes();
  if (!all.length) return log('no box is up');
  for (const server of all) log(`${server.name} ${server.server_type?.name} ${ipOf(server)}: ${cost(server)}; tunnel ${tunnelUp() ? 'open' : 'closed'}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2];
  if (command === 'up') await up();
  else if (command === 'down') down();
  else if (command === 'status') status();
  else if (command === 'env') console.log('DEMO_BOX=1');
  else fail('usage: node box.mjs up|status|env|down');
}
