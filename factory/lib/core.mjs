import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

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
export function haltCheck() {
  if (fs.existsSync(p('HALT'))) { log('halt', { msg: 'HALT file present, stopping' }); process.exit(3); }
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
const CODE_BAD = [/\bchild_process\b/, /\bfetch\s*\(/, /\bhttps?\.(get|request)\s*\(/, /\bnode:(net|dgram|tls)\b/, /process\.env\.[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD)/i];
export function codeViolations(rel, content) {
  if (!/\.(mjs|js|cjs|html)$/.test(rel) || /(^|\/)test\//.test(rel.replace(/\\/g, '/'))) return [];
  return CODE_BAD.filter((r) => r.test(content)).map((r) => `${rel}: forbidden pattern ${r}`);
}

// ---- ollama ----
export async function chat(role, system, user, { json = false, temperature = 0.4 } = {}) {
  const model = cfg.models[role];
  const body = {
    model, stream: false, think: false, keep_alive: cfg.ollama.keepAlive,
    options: { num_ctx: cfg.contextTokens, temperature },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  };
  if (json) body.format = 'json';
  const res = await fetch(cfg.ollama.host + '/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(cfg.ollama.timeoutMs),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const j = await res.json();
  log('llm', { role, model, msg: `${role}/${model} ${j.eval_count ?? '?'} tok` });
  return (j.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
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
export function listTasks(label) {
  const dir = p('backlog', 'tasks');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => {
    const txt = fs.readFileSync(path.join(dir, f), 'utf8');
    const fm = (txt.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [, ''])[1];
    const get = (k) => (fm.match(new RegExp(`^${k}:\\s*(.*)$`, 'm')) || [, ''])[1].replace(/^['"]|['"]$/g, '').trim();
    const labels = (get('labels').match(/[\w-]+/g) || []);
    return { id: get('id'), title: get('title'), status: get('status'), labels, file: path.join(dir, f), body: txt.slice(fm.length + 8) };
  }).filter((t) => !label || t.labels.includes(label))
    .sort((a, b) => parseInt(a.id.replace(/\D/g, '')) - parseInt(b.id.replace(/\D/g, '')));
}

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
