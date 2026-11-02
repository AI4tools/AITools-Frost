#!/usr/bin/env node
/**
 * External OpenCode caller - unified helper.
 *
 * Uses the ALREADY-RUNNING shared OpenCode service. It does NOT start a new server.
 *
 * HTTP transport (V2):
 *   direct  - plain HTTP to the shared service, discovered from
 *             ~/.local/state/opencode/service.json (url + password, Basic auth).
 *             No subprocess, no new server. This is the default.
 *   cli     - shell out to `opencode api ...` (auto-discovery + auth), for when
 *             the state file is missing/stale.
 *
 * Commands:
 *   node opencode.mjs models
 *   node opencode.mjs service                                             # show discovered service
 *   node opencode.mjs --json-args '{"func":"ask","model":"glm","text":"hi"}'   # or `call --json-args @file.json`
 *   node opencode.mjs cli   [--model ALIAS] [--agent A] [-c|--session S] [--json] [--dir D] [--title T] <prompt...>
 *   node opencode.mjs ask   [--model ALIAS] [--agent A] [--dir D] [--title T] [--rm] [--prompt-file FILE|--prompt-stdin] <prompt...>
 *   node opencode.mjs gc    [--older-than HOURS] [--force]                     # list old sessions (dry run unless --force)
 *   node opencode.mjs session-create [--model ALIAS] [--agent A] [--dir D] [--title T]
 *   node opencode.mjs session-send   --session SES [--timeout MS] <text...>          # prompt + wait
 *   node opencode.mjs session-prompt --session SES <text...>                         # fire and forget
 *   node opencode.mjs session-wait   --session SES [--timeout MS]                    # wait for in-flight turn
 *   node opencode.mjs session-delete --session SES
 *   node opencode.mjs api <method> <path> [--data JSON]                              # raw passthrough
 *
 * Transport for HTTP commands: --via auto|direct|cli   (default: auto)
 * CLI binary for the `cli` command / cli transport: $OPENCODE_BIN (default "opencode")
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = dirname(HERE);
const CATALOG = JSON.parse(readFileSync(join(SKILL_DIR, 'models.json'), 'utf8'));

/* ---------------- locate the CLI ---------------- */

// Node >= 20.12 refuses to spawn .cmd/.bat without shell:true (ENOENT), but
// shell:true concatenates args unescaped, which corrupts JSON bodies and
// prompts. So on Windows resolve npm shims to the real .exe and spawn directly.
function resolveBin(bin) {
  if (process.platform !== 'win32') return bin;
  if (/[\\/]/.test(bin) || /\.exe$/i.test(bin)) return bin;
  const dirs = (process.env.PATH || '').split(';').filter(Boolean);
  for (const d of dirs) {
    const p = join(d, bin + '.exe');
    if (existsSync(p)) return p;
  }
  for (const d of dirs) {
    const shim = join(d, bin + '.cmd');
    if (!existsSync(shim)) continue;
    try {
      const txt = readFileSync(shim, 'utf8');
      const m = txt.match(/"(%dp0%\\[^"]+\.exe)"/i) || txt.match(/"([^"]+\.exe)"/i);
      if (m) {
        const target = m[1].replace(/%dp0%/i, d);
        if (existsSync(target)) return target;
      }
    } catch {
      /* fall through */
    }
  }
  return bin;
}

const BIN = resolveBin(process.env.OPENCODE_BIN || 'opencode');

function binVersion() {
  try {
    return execFileSync(BIN, ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}
const IS_V2 = /v2\./.test(binVersion());

/* ---------------- discover the running shared service ---------------- */

function stateServiceFile() {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(base, 'opencode', 'service.json');
}
function configServiceFile() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'opencode', 'service.json');
}

function readService() {
  const info = {};
  for (const f of [stateServiceFile(), configServiceFile()]) {
    if (!existsSync(f)) continue;
    try {
      Object.assign(info, JSON.parse(readFileSync(f, 'utf8')));
    } catch {
      /* ignore */
    }
  }
  return info;
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function directAvailable(svc) {
  return Boolean(svc.url && svc.password) && (svc.pid ? pidAlive(svc.pid) : true);
}

/* ---------------- transports ---------------- */

async function directApi(url, password, method, path, body) {
  const auth = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
  const headers = { Authorization: auth };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url + path, {
    method: method.toUpperCase(),
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = (await res.text()).trim();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${method.toUpperCase()} ${path}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function cliApi(method, path, body) {
  const args = ['api', method, path];
  if (body !== undefined) args.push('--data', JSON.stringify(body));
  const r = spawnSync(BIN, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw r.error;
  const out = (r.stdout || '').trim();
  if (!out) {
    if (r.status !== 0) throw new Error(`opencode api ${method} ${path} failed (${r.status}): ${(r.stderr || '').trim()}`);
    return null;
  }
  return JSON.parse(out);
}

let VIA = 'auto';
async function api(method, path, body) {
  const svc = readService();
  const wantDirect = VIA === 'direct' || (VIA === 'auto' && directAvailable(svc));
  if (wantDirect) {
    if (!directAvailable(svc)) throw new Error('direct transport unavailable: no live service in service.json');
    return directApi(svc.url.replace(/\/$/, ''), svc.password, method, path, body);
  }
  if (!IS_V2) throw new Error(`HTTP mode needs OpenCode V2 (with the "api" subcommand). Current: "${binVersion()}"`);
  return cliApi(method, path, body);
}

/* ---------------- models ---------------- */

const MODELS = CATALOG.tiers.flatMap((t) => t.models.map((m) => ({ tier: t.id, ...m })));

function resolveModel(key, tier) {
  if (tier) {
    const list = MODELS.filter((m) => m.tier === tier);
    if (!list.length) throw new Error(`unknown tier: ${tier}`);
    return list[0];
  }
  if (!key) return MODELS.find((m) => m.id === CATALOG.default) || MODELS[0];
  const hit =
    MODELS.find((m) => m.alias === key) ||
    MODELS.find((m) => m.tier === key) ||
    MODELS.find((m) => m.id === key);
  if (hit) return hit;
  if (key.includes('/')) {
    const [providerID, ...rest] = key.split('/');
    return { tier: 'custom', alias: key, providerID, modelID: rest.join('/'), id: key, variant: '' };
  }
  const fuzzy = MODELS.find((m) => m.id.includes(key) || m.alias.includes(key));
  if (fuzzy) return fuzzy;
  throw new Error(`cannot resolve model: ${key}`);
}

/* ---------------- CLI (opencode run) ---------------- */

function cli(opts) {
  const m = resolveModel(opts.model, opts.tier);
  const explicit = opts.variant;
  const v = explicit ?? m.variant;
  const base = `${m.providerID}/${m.modelID}`;
  const args = ['run', '--agent', opts.agent || CATALOG.defaultAgent, '--model', IS_V2 && v ? `${base}#${v}` : base];
  // V1: variants are provider-dependent and some upstreams reject them, so only
  // pass --variant when the caller explicitly asked for it.
  if (!IS_V2 && explicit) args.push('--variant', explicit);
  if (opts.title) args.push('--title', opts.title);
  if (opts.session) args.push('--session', opts.session);
  else if (opts.continue) args.push('--continue');
  if (opts.json) args.push('--format', 'json');
  if (opts.prompt) args.push(opts.prompt);
  // stdin MUST be ignored: when an external program invokes us its stdin is often
  // a pipe that stays open, and `opencode run` then blocks reading it forever.
  const run = (shell) => spawnSync(BIN, args, { stdio: ['ignore', 'inherit', 'inherit'], cwd: opts.dir || process.cwd(), shell });
  let r = run(false);
  if (r.error && r.error.code === 'ENOENT' && process.platform === 'win32') r = run(true);
  if (r.error) {
    console.error('ERROR: ' + r.error.message);
    process.exit(1);
  }
  process.exit(r.status ?? 0);
}

/* ---------------- HTTP session helpers ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assertHttp() {
  const svc = readService();
  const direct = VIA === 'direct' || (VIA === 'auto' && directAvailable(svc));
  if (!direct && !IS_V2) throw new Error(`HTTP mode needs the V2 shared service or a V2 CLI. Current CLI: "${binVersion()}"`);
}

async function createSession(opts) {
  assertHttp();
  const m = resolveModel(opts.model, opts.tier);
  const model = { providerID: m.providerID, id: m.modelID };
  const v = opts.variant ?? m.variant;
  if (v) model.variant = v;
  const body = { title: opts.title || 'external', agent: opts.agent || CATALOG.defaultAgent, model };
  if (opts.dir) body.location = { directory: opts.dir };
  const r = await api('post', '/api/session', body);
  return r.data;
}

async function readMessages(sid, tries = 3) {
  // A just-created session can briefly 404 while it is being indexed; retry.
  for (let i = 0; ; i++) {
    try {
      return ((await api('get', `/api/session/${sid}/message`)).data) || [];
    } catch (e) {
      if (i >= tries - 1 || !/404/.test(e.message)) throw e;
      await sleep(800);
    }
  }
}
const idleCount = (ms) => ms.filter((m) => m.type === 'idle').length;

// The most recent idle marker, which carries the turn's outcome/error.
function latestIdle(ms) {
  const idles = ms.filter((m) => m.type === 'idle');
  idles.sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0));
  return idles[0];
}

// A finished turn can still fail (e.g. unavailable variant/model). Surface it
// instead of printing an empty reply and exiting 0.
function turnFailure(messages) {
  const idle = latestIdle(messages);
  if (idle && idle.outcome && idle.outcome !== 'succeeded') {
    return idle.error?.message || `turn ${idle.outcome}`;
  }
  return null;
}

// Wait until a NEW turn finishes: the number of "idle" markers exceeds the baseline.
// (A naive "any idle exists" check returns immediately on the 2nd turn of a session.)
async function waitForNewIdle(sid, baseIdle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let messages = await readMessages(sid);
  while (Date.now() < deadline) {
    await sleep(1500);
    messages = await readMessages(sid);
    if (idleCount(messages) > baseIdle) return messages;
  }
  return messages;
}

function noteAssistant(messages) {
  // NOTE: messages come back newest-first, so pick the assistant with the
  // greatest timestamp instead of "the last one in the array".
  const assistants = messages.filter((m) => m.type === 'assistant');
  if (!assistants.length) return { text: '', cost: undefined, tokens: undefined };
  assistants.sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0));
  const m = assistants[0];
  const text = (m.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  return { text, cost: m.cost, tokens: m.tokens };
}

async function ask(opts) {
  const s = await createSession(opts);
  process.stderr.write(`session ${s.id}  model ${s.model?.providerID}/${s.model?.id}${s.model?.variant ? '#' + s.model.variant : ''}\n`);
  let failure = null;
  try {
    const baseIdle = idleCount(await readMessages(s.id));
    await api('post', `/api/session/${s.id}/prompt`, { text: opts.prompt });
    const messages = await waitForNewIdle(s.id, baseIdle, opts.timeout || 600000);
    failure = turnFailure(messages);
    if (!failure) process.stdout.write((noteAssistant(messages).text || '') + '\n');
  } finally {
    // Sessions are KEPT by default. Creating a session and deleting it within
    // the same second makes clients that poll the shared service (e.g. the
    // desktop UI) race on an already-gone session and pop "Session not found",
    // so deletion is opt-in via --rm. Prune the leftovers with `gc`.
    if (opts.rm) {
      try {
        await api('delete', `/api/session/${s.id}`);
      } catch {
        /* ignore */
      }
    } else {
      process.stderr.write(`kept session ${s.id}\n`);
    }
  }
  if (failure) throw new Error(`model turn failed: ${failure}`);
}

// prompt + wait in one call: the safe primitive for multi-turn conversations.
async function sessionSend(opts) {
  assertHttp();
  if (!opts.session) throw new Error('--session required');
  const baseIdle = idleCount(await readMessages(opts.session));
  await api('post', `/api/session/${opts.session}/prompt`, { text: opts.prompt });
  const messages = await waitForNewIdle(opts.session, baseIdle, opts.timeout || 600000);
  const failure = turnFailure(messages);
  if (failure) throw new Error(`model turn failed: ${failure}`);
  process.stdout.write((noteAssistant(messages).text || '') + '\n');
}

/* ---------------- gc: prune old sessions ---------------- */

async function gc(opts) {
  assertHttp();
  const hours = Number.isFinite(opts.olderThan) ? opts.olderThan : 24;
  const cutoff = Date.now() - hours * 3600 * 1000;
  const dry = !opts.force; // SAFE BY DEFAULT: only list unless --force is given
  const res = await api('get', '/api/session');
  const list = (res && (res.data || res)) || [];
  const victims = list.filter((s) => {
    const t = s.time?.updated ?? s.time?.created ?? 0;
    return typeof t === 'number' && t > 0 && t < cutoff;
  });
  if (!victims.length) {
    process.stderr.write(`gc: nothing older than ${hours}h (${list.length} sessions total)\n`);
    return;
  }
  for (const s of victims) {
    if (dry) {
      console.log(`would delete ${s.id}  ${s.title || ''}`);
      continue;
    }
    try {
      await api('delete', `/api/session/${s.id}`);
      console.log(`deleted ${s.id}  ${s.title || ''}`);
    } catch (e) {
      console.error(`failed  ${s.id}: ${e.message}`);
    }
  }
  process.stderr.write(
    `gc: ${victims.length}/${list.length} sessions older than ${hours}h${dry ? ' (DRY RUN - nothing deleted; re-run with --force to delete)' : ' deleted'}\n`,
  );
}

/* ---------------- arg parsing ---------------- */

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--model': case '-m': o.model = next(); break;
      case '--tier': o.tier = next(); break;
      case '--variant': o.variant = next(); break;
      case '--agent': case '-a': o.agent = next(); break;
      case '--session': case '-s': o.session = next(); break;
      case '--continue': case '-c': o.continue = true; break;
      case '--title': case '-t': o.title = next(); break;
      case '--dir': case '-d': o.dir = next(); break;
      case '--via': o.via = next(); break;
      case '--json': o.json = true; break;
      case '--rm': case '--delete': o.rm = true; break;
      case '--keep': o.keep = true; break; // keep is the default now; accepted for compatibility
      case '--force': o.force = true; break;
      case '--older-than': o.olderThan = Number(next()); break;
      case '--dry-run': o.dryRun = true; break;
      case '--timeout': o.timeout = Number(next()); break;
      case '--data': o.data = next(); break;
      case '--prompt-file': case '-f': o.promptFile = next(); break;
      case '--prompt-stdin': o.promptStdin = true; break;
      case '--json-args': case '-j': o.jsonArgs = next(); break;
      default: o._.push(a);
    }
  }
  o.prompt = o._.join(' ');
  // A long/multi-line prompt is best passed as a file or on stdin. Read it as
  // UTF-8 here (in Node) so a shell's ANSI default can't mojibake it on the way
  // in. PowerShell 5.1 in particular reads a BOM-less UTF-8 file as GBK when you
  // use `Get-Content` without `-Encoding UTF8`, turning Chinese into 乱码.
  if (o.promptFile) {
    try {
      o.prompt = readFileSync(o.promptFile, 'utf8').replace(/^\uFEFF/, '');
    } catch (e) {
      console.error('ERROR: cannot read --prompt-file "' + o.promptFile + '": ' + e.message);
      process.exit(1);
    }
  } else if (o.promptStdin) {
    try {
      o.prompt = readFileSync(0, 'utf8').replace(/^\uFEFF/, '');
    } catch (e) {
      console.error('ERROR: cannot read --prompt-stdin: ' + e.message);
      process.exit(1);
    }
  }
  return o;
}

// accept --json-args '{"func":"create","model":"glm","dir":"D:/x"}'
// one JSON object replaces/augments the whole parsed option set; keys mirror
// the long option names (without --). func maps to the subcommand. Values from
// command line flags still win over JSON values.
function applyJsonArgs(o) {
  if (!o.jsonArgs) return o;
  let raw = o.jsonArgs;
  // Convenience: allow "@"file to pass JSON via a file (shell quoting can mangle it).
  if (raw.startsWith('@')) {
    try {
      raw = readFileSync(raw.slice(1), 'utf8');
    } catch (e) {
      console.error('ERROR: cannot read --json-args file: ' + e.message);
      process.exit(1);
    }
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    console.error('ERROR: --json-args is not valid JSON: ' + e.message);
    process.exit(1);
  }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) {
    console.error('ERROR: --json-args must be a JSON object');
    process.exit(1);
  }
  if (j._ !== undefined && Array.isArray(j._)) o._ = j._.map(String);
  const KEYS = ['model', 'tier', 'variant', 'agent', 'session', 'title', 'dir', 'via', 'data', 'olderThan', 'timeout', 'promptFile'];
  for (const k of KEYS) {
    if (j[k] !== undefined && j[k] !== null && j[k] !== '') o[k] = String(j[k]);
  }
  for (const k of ['continue', 'json', 'rm', 'keep', 'force', 'dryRun', 'promptStdin']) {
    if (j[k] !== undefined) o[k] = Boolean(j[k]);
  }
  if (j.prompt !== undefined && j.prompt !== null) o.prompt = String(j.prompt);
  if (j.func !== undefined && j.func !== null) o.func = String(j.func);
  if (j.text !== undefined && j.text !== null && !o.prompt) o.prompt = String(j.text);
  return o;
}

const USAGE = `Usage:
  node opencode.mjs models
  node opencode.mjs service                                                  # show the shared service it will use
  node opencode.mjs --json-args '{"func":"create","model":"glm","dir":"D:/x","text":"hi"}'  # one JSON object for everything
  node opencode.mjs call  --json-args @args.json                             # same, JSON read from a file
  node opencode.mjs cli   [--model ALIAS] [--agent A] [-c] [--session S] [--json] [--dir D] [--title T] <prompt...>
  node opencode.mjs ask   [--model ALIAS] [--agent A] [--dir D] [--title T] [--rm] [--prompt-file FILE|--prompt-stdin] <prompt...>
  node opencode.mjs gc    [--older-than HOURS] [--force]                     # prune old sessions (dry run unless --force; default 24h)
  node opencode.mjs session-create [--model ALIAS] [--agent A] [--dir D] [--title T]
  node opencode.mjs session-send   --session SES [--timeout MS] [--prompt-file F|--prompt-stdin] <text...>
  node opencode.mjs session-prompt --session SES <text...>
  node opencode.mjs session-wait   --session SES [--timeout MS]
  node opencode.mjs session-delete --session SES
  node opencode.mjs api <method> <path> [--data JSON]

HTTP commands connect to the ALREADY-RUNNING shared service (no new server).
Transport: --via auto|direct|cli   (default auto = direct if the service is live)
CLI binary:  $OPENCODE_BIN (default "opencode")`;

const argvRaw = process.argv.slice(2);
// If the first token is a flag (e.g. `--json-args`), there is no subcommand:
// everything is options and the "command" comes from JSON `func`.
const flagsOnly = !argvRaw[0] || argvRaw[0].startsWith('-');
const [cmd0, ...rest] = flagsOnly ? ['', argvRaw[0], ...argvRaw.slice(1)] : argvRaw;
const o = parse(rest);
// command line flags win over JSON values; JSON wins over defaults
applyJsonArgs(o);
// entry: either a normal subcommand, `call` + func, or func given in JSON only.
const FUNC_ALIAS = {
  create: 'session-create',
  new: 'session-create',
  send: 'session-send',
  prompt: 'session-prompt',
  wait: 'session-wait',
  del: 'session-delete',
  delete: 'session-delete',
  remove: 'session-delete',
};
let cmd;
if (flagsOnly) {
  // flags-only invocation: the "command" comes from JSON `func`
  cmd = o.func ? (FUNC_ALIAS[o.func] || o.func) : '';
} else if (cmd0 === 'call') {
  cmd = o.func ? (FUNC_ALIAS[o.func] || o.func) : '';
} else {
  cmd = FUNC_ALIAS[cmd0] || cmd0;
}
if (o.via) VIA = o.via;
else if (process.env.OPENCODE_VIA) VIA = process.env.OPENCODE_VIA;

try {
  switch (cmd) {
    case 'models': {
      const CONC = { limited: '少并发', none: '单并发', unknown: '?' };
      console.log(`${'tier'.padEnd(6)} ${'alias'.padEnd(11)} ${'model'.padEnd(44)} 并发`);
      for (const m of MODELS) {
        const ref = m.id + (m.variant ? '#' + m.variant : '');
        console.log(`${m.tier.padEnd(6)} ${(m.alias || '').padEnd(11)} ${ref.padEnd(44)} ${CONC[m.concurrency] || '?'}`);
      }
      break;
    }
    case 'service': {
      const svc = readService();
      console.log('state file :', stateServiceFile(), existsSync(stateServiceFile()) ? '(found)' : '(missing)');
      console.log('url        :', svc.url || '(unknown)');
      console.log('pid        :', svc.pid ?? '(unknown)', svc.pid ? (pidAlive(svc.pid) ? '(alive)' : '(DEAD)') : '');
      console.log('version    :', svc.version || '(unknown)');
      console.log('password   :', svc.password ? '(set, hidden)' : '(none)');
      console.log('direct     :', directAvailable(svc) ? 'available' : 'NOT available (will fall back to `opencode api`)');
      break;
    }
    case 'cli': cli(o); break;
    case 'ask': await ask(o); break;
    case 'gc': await gc(o); break;
    case 'session-create': {
      const s = await createSession(o);
      console.log(s.id);
      process.stderr.write(`model ${s.model?.providerID}/${s.model?.id}${s.model?.variant ? '#' + s.model.variant : ''}  dir ${s.location?.directory}\n`);
      break;
    }
    case 'session-send': await sessionSend(o); break;
    case 'session-prompt': {
      assertHttp();
      if (!o.session) throw new Error('--session required');
      await api('post', `/api/session/${o.session}/prompt`, { text: o.prompt });
      break;
    }
    case 'session-wait': {
      assertHttp();
      if (!o.session) throw new Error('--session required');
      const base = idleCount(await readMessages(o.session));
      const messages = await waitForNewIdle(o.session, base, o.timeout || 600000);
      const failure = turnFailure(messages);
      if (failure) throw new Error(`model turn failed: ${failure}`);
      process.stdout.write((noteAssistant(messages).text || '') + '\n');
      break;
    }
    case 'session-delete': {
      assertHttp();
      if (!o.session) throw new Error('--session required');
      await api('delete', `/api/session/${o.session}`);
      break;
    }
    case 'api': {
      const method = o._[0];
      const path = o._[1];
      if (!method || !path) throw new Error('usage: api <method> <path> [--data JSON]');
      const body = o.data ? JSON.parse(o.data) : undefined;
      const r = await api(method, path, body);
      if (r !== null) console.log(JSON.stringify(r, null, 2));
      break;
    }
    case '':
      if (o.jsonArgs) { console.error('ERROR: --json-args needs "func" (create/send/prompt/wait/delete/ask/...), or pass a subcommand.'); process.exit(1); }
      console.log(USAGE);
      process.exit(0);
    default:
      console.log(USAGE);
      process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error('ERROR: ' + e.message);
  process.exit(1);
}
