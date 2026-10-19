import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runTests } from './core.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SKIP = new Set(['.git', 'node_modules']);

export function listFiles(dir) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const f = path.join(d, e.name);
    e.isDirectory() ? walk(f) : out.push(path.relative(dir, f).replace(/\\/g, '/'));
  } };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}
export const tree = (dir) => listFiles(dir).map((f) => `${f} (${fs.statSync(path.join(dir, f)).size}b)`).join('\n');

export function stats(dir) {
  const files = listFiles(dir);
  const src = files.filter((f) => /^src\/.+\.mjs$/.test(f));
  const tests = files.filter((f) => /^test\/.+\.test\.mjs$/.test(f));
  const loc = files.filter((f) => /\.(mjs|js|html|css)$/.test(f)).reduce((n, f) => n + fs.readFileSync(path.join(dir, f), 'utf8').split('\n').length, 0);
  const untested = src.map((f) => path.basename(f, '.mjs')).filter((b) => !tests.some((t) => t.includes(b)));
  return { files: files.length, src: src.length, tests: tests.length, loc, srcWithoutMatchingTest: untested };
}

// Smoke tests create databases in the product dir; make sure they can never be committed.
export function ensureGitignore(dir) {
  const want = ['node_modules/', '*.db', '*.db-*', '*.sqlite', '*.sqlite3', '*.sqlite-*', 'data/', '.env'];
  const f = path.join(dir, '.gitignore');
  const have = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split(/\r?\n/) : [];
  const missing = want.filter((w) => !have.includes(w));
  if (missing.length) fs.writeFileSync(f, [...have.filter(Boolean), ...missing].join('\n') + '\n');
}

// Boots the product with a minimal environment (no factory secrets) and probes it over loopback.
export async function smokeTest(dir) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 200) });
  if (!fs.existsSync(path.join(dir, 'src', 'main.mjs'))) { add('src/main.mjs exists', false); return { checks, stderr: '' }; }
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['src/main.mjs'], {
    cwd: dir, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, PORT: String(port) },
  });
  let stderr = '', exited = false;
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
  child.on('exit', () => { exited = true; });
  const base = `http://127.0.0.1:${port}`;
  const get = async (p) => {
    try {
      const r = await fetch(base + p, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      return { status: r.status, type: r.headers.get('content-type') || '', body: await r.text() };
    } catch (e) { return { status: 0, type: '', body: '', error: e.message }; }
  };
  try {
    let root = null;
    for (let i = 0; i < 30 && !exited; i++) { root = await get('/'); if (root.status) break; await sleep(500); }
    add('server starts and answers GET /', root?.status && root.status < 500, root?.status || 'no response');
    if (root?.status) {
      add('GET / returns html', /html/.test(root.type), root.type);
      const assets = [...root.body.matchAll(/(?:src|href)=["'](\/[^"'#?]+)/g)].map((m) => m[1]).slice(0, 20);
      for (const a of assets) { const r = await get(a); add(`asset ${a} loads`, r.status === 200, r.status); }
      const nf = await get('/__factory_missing__');
      add('unknown path gives 3xx/4xx, not 5xx', nf.status >= 300 && nf.status < 500, nf.status);
      const api = await get('/api/__factory_missing__');
      add('unknown api path handled without 5xx', api.status > 0 && api.status < 500, api.status);
      const alive = await get('/');
      add('server survives bad requests', alive.status > 0 && alive.status < 500, alive.status);
      add('landing page has no external assets', !/(?:src|href)=["']https?:\/\/(?!127\.0\.0\.1|localhost)/i.test(root.body));
    }
  } finally { child.kill(); await sleep(300); }
  return { checks, stderr };
}

export async function mechanicalEval(dir) {
  ensureGitignore(dir);
  return { tests: runTests(dir), smoke: await smokeTest(dir), stats: stats(dir) };
}
