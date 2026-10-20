import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { spawnSync } from 'node:child_process';
import { cfg, log, haltCheck } from './core.mjs';

// Dependencies are chosen by agents but vetted and installed only by the orchestrator (read-only registry lookups, --ignore-scripts).
const REGISTRY = 'https://registry.npmjs.org/';
const DOWNLOADS = 'https://api.npmjs.org/downloads/point/last-week/';
const NAME_RE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;
const NPM = 'npm';
const policy = () => cfg.dependencies;
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

async function getJson(url) {
  haltCheck();
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'software-factory-deps/1.0 (read-only)' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${new URL(url).hostname} ${r.status}`);
  return r.json();
}

export async function vetPackage(name) {
  const pol = policy();
  if (!NAME_RE.test(name) || name.length > 100) return { ok: false, reason: 'invalid package name' };
  if ((pol.blocklist || []).includes(name)) return { ok: false, reason: 'blocklisted' };
  let meta, dl;
  try {
    meta = await getJson(REGISTRY + name.replace('/', '%2F'));
    dl = await getJson(DOWNLOADS + name.replace('/', '%2F'));
  } catch (e) { return { ok: false, reason: `registry lookup failed (${e.message})` }; }
  const version = meta['dist-tags']?.latest;
  const v = meta.versions?.[version];
  if (!v) return { ok: false, reason: 'no latest version' };
  if (v.deprecated) return { ok: false, reason: 'deprecated: ' + String(v.deprecated).slice(0, 100) };
  const lic = typeof v.license === 'string' ? v.license : v.license?.type || '';
  if (!new RegExp(pol.allowedLicenses, 'i').test(lic)) return { ok: false, reason: `license "${lic || 'none'}" not allowed` };
  const days = (Date.now() - Date.parse(meta.time?.[version] || 0)) / 86400000;
  if (!(days <= pol.maxStaleDays)) return { ok: false, reason: `last release ${Math.round(days)} days ago` };
  if ((dl.downloads || 0) < pol.minWeeklyDownloads) return { ok: false, reason: `only ${dl.downloads || 0} weekly downloads` };
  const s = v.scripts || {};
  if (s.preinstall || s.install || s.postinstall || v.gypfile) return { ok: false, reason: 'has install scripts / native build (needs a pure-JS alternative)' };
  return { ok: true, version, license: lic, weeklyDownloads: dl.downloads, ageDays: Math.round(days) };
}

function ensurePackageJson(dir, slug) {
  const f = path.join(dir, 'package.json');
  if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify({ name: slug, version: '0.1.0', private: true, type: 'module', scripts: { test: 'node --test', start: 'node src/main.mjs' }, dependencies: {} }, null, 2) + '\n');
  return f;
}
export const declared = (dir) => { const f = path.join(dir, 'package.json'); return fs.existsSync(f) ? Object.keys(read(f).dependencies || {}) : []; };

export function ensureNodeProject(dir, slug) {
  const f = ensurePackageJson(dir, slug);
  const pkg = read(f);
  pkg.scripts ||= {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!pkg.scripts.test) pkg.scripts.test = deps.vitest ? 'vitest run' : deps['@angular/cli'] ? 'ng test --watch=false' : 'node --test';
  if (deps.vite && !pkg.scripts.build) pkg.scripts.build = 'vite build';
  if (deps['@angular/cli']) {
    if (!pkg.scripts.build) pkg.scripts.build = 'ng build';
    if (!pkg.scripts.test) pkg.scripts.test = 'ng test --watch=false';
    if (!pkg.scripts['test:unit']) pkg.scripts['test:unit'] = 'ng test --watch=false';
  }
  if (deps.eslint && !pkg.scripts.lint) pkg.scripts.lint = 'eslint .';
  if (deps.prettier && !pkg.scripts['format:check']) pkg.scripts['format:check'] = 'prettier --check .';
  if (deps.typescript && !pkg.scripts.typecheck) pkg.scripts.typecheck = 'tsc --noEmit';
  if (deps.vitest && !pkg.scripts['test:unit']) pkg.scripts['test:unit'] = 'vitest run';
  if (deps['@playwright/test'] && !pkg.scripts['test:e2e']) pkg.scripts['test:e2e'] = 'playwright test';
  if (fs.existsSync(path.join(dir, 'test', 'unit')) && !pkg.scripts['test:unit']) pkg.scripts['test:unit'] = 'node --test test/unit';
  if (fs.existsSync(path.join(dir, 'test', 'integration')) && !pkg.scripts['test:integration']) pkg.scripts['test:integration'] = 'node --test test/integration';
  fs.writeFileSync(f, JSON.stringify(pkg, null, 2) + '\n');
  const lock = spawnSync(NPM, ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir, encoding: 'utf8', timeout: 180000, windowsHide: true });
  if (lock.status !== 0) throw new Error(`could not create/update npm lockfile: ${(lock.stderr || lock.stdout || lock.error?.message || '').slice(-500)}`);
  return f;
}

export function parseDependencies(reply) {
  const m = reply.match(/^\s*DEPENDENCIES:\s*(.+)$/im);
  if (!m) return [];
  return [...new Set(m[1].split(/[,\s]+/).map((s) => s.replace(/[`'"]/g, '').replace(/@[\d^~][\w.^~-]*$/, '').trim()).filter(Boolean))]
    .filter((s) => !/^(none|n\/a|-)$/i.test(s));
}

// Returns { added: [], rejected: [{name, reason}] }. Rejections are fed back to the engineer.
export async function ensureDeps(dir, slug, names) {
  const pol = policy();
  const added = [], rejected = [];
  if (!pol.enabled || !names.length) return { added, rejected: pol.enabled ? [] : names.map((name) => ({ name, reason: 'dependencies are disabled in factory.config.json' })) };
  ensurePackageJson(dir, slug);
  const have = new Set(declared(dir));
  for (const name of names) {
    if (builtinModules.includes(name) || name.startsWith('node:') || have.has(name)) continue;
    if (have.size + added.length >= pol.maxPerProduct) { rejected.push({ name, reason: `product already has ${pol.maxPerProduct} dependencies (max)` }); continue; }
    const v = await vetPackage(name);
    if (!v.ok) { rejected.push({ name, reason: v.reason }); log('dep-rejected', { slug, msg: `${name}: ${v.reason}` }); continue; }
    const r = spawnSync(NPM, ['install', `${name}@${v.version}`, '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir, encoding: 'utf8', timeout: 180000, windowsHide: true });
    if (r.status !== 0) { rejected.push({ name, reason: 'npm install failed: ' + (r.stderr || '').slice(-200) }); continue; }
    const a = spawnSync(NPM, ['audit', '--omit=dev', '--json'], { cwd: dir, encoding: 'utf8', timeout: 120000, windowsHide: true });
    let bad = 0;
    try { const t = JSON.parse(a.stdout).metadata?.vulnerabilities || {}; bad = (t.high || 0) + (t.critical || 0); } catch { /* audit unavailable: allow */ }
    if (bad) {
      spawnSync(NPM, ['uninstall', name, '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir, encoding: 'utf8', timeout: 180000, windowsHide: true });
      rejected.push({ name, reason: `npm audit reports ${bad} high/critical vulnerabilities` });
      continue;
    }
    added.push(`${name}@${v.version}`);
    log('dep-added', { slug, msg: `${name}@${v.version} (${v.license}, ${v.weeklyDownloads} dl/wk)` });
  }
  return { added, rejected };
}

// Bare-specifier imports in a file that are not Node built-ins, relative paths, or declared dependencies.
export function undeclaredImports(content, declaredNames) {
  const out = new Set();
  const re = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(content))) {
    const s = m[1];
    if (s.startsWith('.') || s.startsWith('/') || s.startsWith('node:') || s.startsWith('http')) continue;
    const pkg = s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0];
    if (builtinModules.includes(pkg) || declaredNames.includes(pkg)) continue;
    out.add(pkg);
  }
  return [...out];
}

export function preferredText() {
  const pr = cfg.dependencies.preferred || {};
  return 'PREFERRED LIBRARIES (use these for the need listed; all are pure-JS, permissive, widely used):\n' + Object.entries(pr).map(([k, v]) => `- ${k}: ${v}`).join('\n');
}
