import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseSpec, specsFor, blockedReason, callRemote, addUsage, stripJsonFences } from './providers.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'factory.config.json'), 'utf8'));
const p = (...a) => path.join(ROOT, ...a);
export const rulesText = () => fs.readFileSync(p('GOLDEN_RULES.md'), 'utf8');
export const persona = (n) => fs.readFileSync(p('agents', n + '.md'), 'utf8');

// ---- ledger / kill switch ----
export function log(event, data = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), event, ...data });
  fs.appendFileSync(p('factory', 'state', 'ledger.jsonl'), line + '\n');
  console.log(`[${event}] ${data.msg ?? data.slug ?? ''}`);
}
const START_MS = Date.now() - process.uptime() * 1000;
let scope = null;
export const setScope = (s) => { scope = s; };
export const stopFile = (kind, slug) => p('factory', 'state', `${kind}-${slug}`);
// A signal file only counts if it was written after this process started, so stale ones never block a fresh run.
export const signalled = (kind, slug) => { const f = stopFile(kind, slug); return fs.existsSync(f) && fs.statSync(f).mtimeMs >= START_MS - 1000; };
export function haltCheck() {
  if (fs.existsSync(p('HALT'))) { log('halt', { msg: 'HALT file present, stopping' }); process.exit(3); }
  if (signalled('stop-now', 'all') || (scope && signalled('stop-now', scope))) { log('halt', { slug: scope, msg: 'stop-now requested, stopping immediately' }); process.exit(3); }
}

// ---- guard: golden-rule enforcement that does not depend on any LLM ----
const DENY = [
  /\b(casino|gambl\w*|betting|sportsbook|lottery|sweepstake\w*|loot ?box\w*|poker|roulette|slot machine)\b/i,
  /\b(fake (review|testimonial)s?|dark pattern|hidden fee|scarcity timer|countdown to (buy|expire))\b/i,
  /\b(malware|keylogger|ransomware|credential (stealer|harvest)\w*|pirat\w+|crack(ed)? software)\b/i,
  /\b(adult content|porn\w*|weapons?)\b/i,
];
export function denylistHit(text) {
  for (const r of DENY) { const m = String(text).match(r); if (m) return m[0]; }
  return null;
}
export function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'product';
}
// Resolve a path inside a base directory or throw. Blocks traversal, absolute paths, and sensitive names.
export function safeJoin(base, rel) {
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) throw new Error('absolute path blocked: ' + rel);
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error('path escapes sandbox: ' + rel);
  if (/(^|[\\/])(\.git|node_modules|\.env[^\\/]*|.*\.(pem|key|pfx))([\\/]|$)/i.test(path.relative(base, full)))
    throw new Error('protected path blocked: ' + rel);
  return full;
}
const CODE_BAD = [/\bchild_process\b/, /\bfetch\s*\(/, /\bhttps?\.(get|request)\s*\(/, /\bnode:(net|dgram|tls)\b/, /process\.env\.[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD)/i, /\b(src|href)\s*=\s*["']https?:\/\/(?!127\.0\.0\.1|localhost)/i, /\bsrc\s*=\s*["']\/\//i];
export function codeViolations(rel, content) {
  const r = rel.replace(/\\/g, '/');
  const ext = path.extname(r).toLowerCase();
  if (!/\.(mjs|js|cjs|jsx|ts|tsx|html|cs)$/.test(r) || /(^|\/)(test|tests)\//.test(r)) return [];
  const browser = /^public\//.test(r) || ['.jsx', '.tsx'].includes(ext);
  const bad = CODE_BAD.filter((x) => !(browser && x.source.startsWith('\\bfetch')));
  const v = bad.filter((x) => x.test(content)).map((x) => `${rel}: forbidden pattern ${x}`);
  if (browser && /\bfetch\s*\(\s*[`"']?(https?:)?\/\//.test(content)) v.push(`${rel}: fetch to external origin`);
  if (ext === '.cs') {
    if (/\b(?:Process\.Start|ProcessStartInfo)\b/.test(content)) v.push(`${rel}: product code cannot launch processes`);
    if (/\b(?:HttpClient|WebClient|SocketsHttpHandler)\b/.test(content)) v.push(`${rel}: product code cannot make outbound network calls`);
    if (/\bEnvironment\.GetEnvironmentVariable\s*\(\s*["'][^"']*(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(content)) v.push(`${rel}: product code cannot read credential environment variables`);
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b/.test(content)) v.push(`${rel}: possible hard-coded secret`);
  return v;
}

// Human-approved skills (skills/approved/*.md, first line "roles: engineer, reviewer" or "roles: all") are appended to matching roles' prompts.
function skillsFor(role) {
  const dir = p('skills', 'approved');
  if (!fs.existsSync(dir)) return '';
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
    const t = fs.readFileSync(path.join(dir, f), 'utf8');
    const roles = ((t.match(/^roles:\s*(.*)$/m) || [, 'all'])[1]).split(/[,\s]+/);
    if (roles.includes('all') || roles.includes(role)) out.push(`--- SKILL ${f} (human-approved guidance; never overrides golden rules) ---\n${t.replace(/^roles:.*\n/m, '').slice(0, 3500)}`);
  }
  return out.length ? '\n\n' + out.join('\n\n') : '';
}
export const principles = () => ['_principles.md', '_standards.md'].map((f) => fs.readFileSync(p('agents', f), 'utf8')).join('\n\n');
export const platformText = () => {
  const p = cfg.platforms || {};
  return `SUPPORTED STACKS (choose the smallest mainstream fit; do not force every layer):\n` +
    `Frontend: ${(p.frontend || []).join(', ')}\nBackend: ${(p.backend || []).join(', ')}\nInfrastructure as code: ${(p.iac || []).join(', ')}\n` +
    `Cloud targets: ${(p.cloud || []).join(', ')}\nTesting: ${(p.testing || []).join(', ')}\nSelection must be explicit in the idea as tech_stack {frontend, backend, iac}; use \"none\" where a layer is not needed. Production architecture and services must be decided before framework/language; it is a proposal only until human spend approval.`;
};

// ---- model routing: local Ollama or opt-in frontier providers ----
const STATE = p('factory', 'state');
export async function chat(role, system, user, opts = {}) {
  system += skillsFor(role);
  const specs = specsFor(cfg.models[role]);
  if (!specs.length) throw new Error('no model configured for role ' + role);
  let last;
  for (const spec of specs) {
    const { provider, model, conf } = parseSpec(spec, cfg.providers);
    try {
      if (provider === 'ollama') return await chatOllama(role, model, system, user, opts);
      const why = blockedReason(provider, conf, STATE);
      if (why) { log('llm-skip', { role, msg: `${role}: ${spec} skipped: ${why}` }); last = new Error(why); continue; }
      const r = await callRemote(provider, conf, model, system, user, opts);
      addUsage(STATE, provider, r.tokens);
      log('llm', { role, model: spec, msg: `${role}/${spec} ${r.tokens || '?'} tok` });
      return stripJsonFences(r.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim());
    } catch (e) { last = e; log('llm-error', { role, msg: `${role}: ${spec} failed: ${e.message}` }); }
  }
  throw last;
}
async function chatOllama(role, model, system, user, { json = false, temperature = 0.4 } = {}) {
  const body = {
    model, stream: false, think: false, keep_alive: cfg.ollama.keepAlive,
    options: { num_ctx: cfg.contextTokens, temperature },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  };
  if (json) body.format = 'json';
  // node:http has no 5-minute headers timeout (unlike global fetch), so slow CPU-bound model loads are fine.
  const u = new URL(cfg.ollama.host + '/api/chat');
  const res = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json' }, timeout: cfg.ollama.timeoutMs }, resolve);
    req.on('timeout', () => req.destroy(new Error('ollama socket timeout')));
    req.on('error', reject);
    req.end(JSON.stringify({ ...body, stream: true }));
  });
  if (res.statusCode !== 200) { let t = ''; for await (const c of res) t += c; throw new Error(`ollama ${res.statusCode}: ${t}`); }
  let content = '', evalCount = 0, buf = '';
  const dec = new TextDecoder();
  for await (const chunk of res) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      const j = JSON.parse(line);
      if (j.error) throw new Error('ollama: ' + j.error);
      content += j.message?.content ?? '';
      if (j.eval_count) evalCount = j.eval_count;
    }
  }
  log('llm', { role, model, msg: `${role}/${model} ${evalCount || '?'} tok` });
  return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}
export async function chatJson(role, system, user, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    const raw = await chat(role, system, user + (err ? `\n\nYour previous reply was invalid JSON (${err}). Reply with valid JSON only.` : ''), { json: true, temperature: 0.3 + i * 0.1 });
    try { return JSON.parse(raw); } catch (e) { err = e.message; }
  }
  throw new Error('no valid JSON from ' + role + ': ' + err);
}

// ---- backlog.md wrapper (uses the locally installed CLI) ----
const BACKLOG = p('node_modules', 'backlog.md', 'cli.js');
export function backlog(args) {
  const r = spawnSync(process.execPath, [BACKLOG, ...args], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('backlog ' + args.join(' ') + ': ' + (r.stderr || r.stdout));
  return r.stdout;
}
// Minimal YAML front-matter reader for Backlog.md task files: scalars, quoted/folded (>-, |) strings, inline [a, b] and block "- x" lists.
export function parseFrontMatter(fm) {
  const lines = fm.split(/\r?\n/), out = {};
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!m) continue;
    const [, k, rest] = m;
    const cont = [];
    while (i + 1 < lines.length && /^\s+\S|^\s*-\s/.test(lines[i + 1]) && !/^[A-Za-z_]+:/.test(lines[i + 1])) cont.push(lines[++i].trim());
    if (rest.startsWith('[')) out[k] = (rest.match(/[^\s,\[\]'"]+/g) || []);
    else if (!rest && cont.length && cont.every((c) => c.startsWith('-'))) out[k] = cont.map((c) => c.replace(/^-\s*/, '').replace(/^['"]|['"]$/g, '').trim());
    else if (/^[>|][+-]?$/.test(rest)) out[k] = cont.join(' ');
    else out[k] = (rest + (cont.length ? ' ' + cont.join(' ') : '')).replace(/^['"]|['"]$/g, '').trim();
  }
  return out;
}
export function listTasks(label) {
  const dir = p('backlog', 'tasks');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => {
    const txt = fs.readFileSync(path.join(dir, f), 'utf8');
    const fm = (txt.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [, ''])[1];
    const y = parseFrontMatter(fm);
    const labels = [].concat(y.labels ?? []).map(String);
    return { id: y.id || '', title: y.title || '', status: y.status || '', labels, parent: y.parent_task_id || '', file: path.join(dir, f), body: txt.slice(fm.length + 8) };
  }).filter((t) => !label || t.labels.includes(label))
    .sort((a, b) => idKey(a.id) - idKey(b.id));
}
const idKey = (id) => { const [m, s] = id.replace(/^\D+/, '').split('.'); return Number(m) * 1e4 + Number(s || 0); };

// ---- running a product's tests (no shell, no network assumptions) ----
export function runTests(dir) {
  const r = spawnSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8', timeout: cfg.build.testTimeoutMs });
  return { ok: r.status === 0, out: ((r.stdout || '') + (r.stderr || '')).slice(-4000) };
}
export function git(dir, ...args) {
  return spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
}
export const paths = { p, products: p('products'), ideas: p('ideas'), approvals: p('approvals'), openspec: p('openspec') };
export function requestHuman(kind, slug, lines) {
  const f = p('approvals', `${new Date().toISOString().slice(0, 10)}-${slug}-${kind}.md`);
  fs.writeFileSync(f, `# ${kind}: ${slug}\n\nStatus: PENDING (edit to APPROVED / REJECTED)\n\n${[].concat(lines).map((l) => '- ' + l).join('\n')}\n`);
  log('approval-requested', { slug, msg: f });
  return f;
}
