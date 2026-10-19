#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ROOT, cfg, rulesText, principles, persona, log, haltCheck, denylistHit, slugify, safeJoin, codeViolations,
  chat, chatJson, backlog, listTasks, runTests, git, paths, requestHuman, setScope, stopFile,
} from './lib/core.mjs';
import { mechanicalEval, tree, ensureGitignore } from './lib/evaluate.mjs';
import { ensureDeps, parseDependencies, declared, undeclaredImports, preferredText } from './lib/deps.mjs';
import { scout, toolsList, toolsDecide } from './lib/scout.mjs';
import { gatherSignals, loadFreshResearch, saveResearch } from './lib/research.mjs';

const RULES = () => `GOLDEN RULES:\n${rulesText()}\n\n${principles()}\n${preferredText()}`;
const read = (f) => fs.readFileSync(f, 'utf8');
const exists = fs.existsSync;

// ---------- 0. RESEARCH (read-only public web signals -> opportunities) ----------
async function research(force = false) {
  haltCheck();
  const cached = force ? null : loadFreshResearch();
  if (cached) { log('research', { msg: `reusing research from ${cached.at}` }); return cached; }
  const signals = await gatherSignals();
  log('research', { msg: `${signals.length} signals gathered` });
  if (signals.length < 8) throw new Error('too few research signals (network blocked?); refusing to invent demand');
  const digest = signals.map((s, i) => `${i + 1}. [${s.source}] ${s.title} | ${s.text} | score ${s.score}, ${s.comments} comments | ${s.url}`).join('\n');
  const out = await chatJson('analyst', persona('analyst') + '\n\n' + RULES(), `Signals:\n${digest}`);
  const known = new Set(signals.map((s) => s.url));
  const opps = (out.opportunities || []).map((o) => ({ ...o, evidence: (o.evidence || []).filter((u) => known.has(u)) })).filter((o) => o.evidence.length);
  if (!opps.length) throw new Error('analyst returned no evidence-backed opportunities');
  const res = { at: new Date().toISOString(), signals, opportunities: opps };
  saveResearch(res);
  log('research', { msg: `${opps.length} evidence-backed opportunities` });
  return res;
}

// ---------- 1. IDEATE ----------
async function ideate(hint = '') {
  haltCheck();
  const existing = exists(paths.ideas) ? fs.readdirSync(paths.ideas).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')) : [];
  const r = await research();
  const idea = await chatJson('strategist', persona('strategist') + '\n\n' + RULES(),
    `Existing ideas (do not duplicate): ${existing.join(', ') || 'none'}.\n${hint ? 'Human hint: ' + hint : 'Choose the best opportunity.'}\n\nResearched opportunities:\n${JSON.stringify(r.opportunities, null, 1)}`);
  if (!Array.isArray(idea.evidence) || !idea.evidence.length) idea.evidence = r.opportunities[0].evidence;
  idea.name = slugify(idea.name || idea.title);
  const hit = denylistHit(JSON.stringify(idea));
  let verdict = { approved: !hit, violations: hit ? [`denylist match: ${hit}`] : [], needs_human: [] };
  if (!hit) verdict = await chatJson('compliance', persona('compliance') + '\n\n' + RULES(), JSON.stringify(idea));
  idea.compliance = verdict;
  idea.status = verdict.approved ? 'approved' : 'rejected';
  fs.writeFileSync(path.join(paths.ideas, idea.name + '.json'), JSON.stringify(idea, null, 2));
  log('ideate', { slug: idea.name, msg: `${idea.name}: ${idea.status} ${verdict.violations?.join('; ') ?? ''}` });
  if (verdict.needs_human?.length) requestHuman('needs-human', idea.name, verdict.needs_human);
  return idea.status === 'approved' ? idea.name : null;
}

// ---------- 2. PLAN (OpenSpec + backlog.md) ----------
async function plan(slug) {
  haltCheck();
  const ideaFile = path.join(paths.ideas, slug + '.json');
  const idea = JSON.parse(read(ideaFile));
  if (idea.status !== 'approved') throw new Error('idea not approved');
  const pl = await chatJson('pm', persona('pm') + '\n\n' + RULES(), JSON.stringify(idea));
  if (!Array.isArray(pl.tasks) || !pl.tasks.length || !Array.isArray(pl.requirements)) throw new Error('bad plan shape');
  materialize(slug, pl, slug, []);
  idea.status = 'planned';
  fs.writeFileSync(ideaFile, JSON.stringify(idea, null, 2));
}

// Writes the OpenSpec change and creates the backlog.md tasks for a plan.
function materialize(slug, pl, changeName, extraLabels) {
  const cap = slugify(pl.capability || slug);
  const dir = path.join(paths.openspec, 'changes', changeName);
  fs.mkdirSync(path.join(dir, 'specs', cap), { recursive: true });
  fs.writeFileSync(path.join(dir, 'proposal.md'), `## Why\n${pl.why}\n\n## What Changes\n${pl.what_changes}\n\n## Impact\n- Affected specs: ${cap}\n- Product: products/${slug}\n`);
  fs.writeFileSync(path.join(dir, 'design.md'), `## Design\n${pl.design}\n`);
  fs.writeFileSync(path.join(dir, 'tasks.md'), '## 1. Implementation\n' + pl.tasks.map((t, i) => `- [ ] 1.${i + 1} ${t.title}`).join('\n') + '\n');
  const specs = pl.requirements.map((r) => `### Requirement: ${r.name}\n${/\b(SHALL|MUST)\b/.test(r.text) ? r.text : 'The system SHALL ' + r.text}\n\n` +
    (r.scenarios?.length ? r.scenarios : [{ name: 'Basic', when: 'used normally', then: 'it works as described' }])
      .map((s) => `#### Scenario: ${s.name}\n- **WHEN** ${s.when}\n- **THEN** ${s.then}\n`).join('\n')).join('\n');
  fs.writeFileSync(path.join(dir, 'specs', cap, 'spec.md'), `## ADDED Requirements\n${specs}`);
  const v = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', '@fission-ai', 'openspec', 'bin', 'openspec.js'),   'validate', changeName, '--type', 'change'], { cwd: ROOT, encoding: 'utf8' });
    log('openspec-validate', { slug, msg: (v.status === 0 ? 'valid' : 'INVALID ' + (v.stdout + v.stderr).slice(0, 300)) });
    for (const t of pl.tasks) {
      const desc = `${t.description}\n\nFiles: ${(t.files || []).join(', ')}\nSpec: openspec/changes/${changeName}`;
      const args = ['task', 'create', t.title, '-d', desc, '-l', [slug, ...extraLabels].join(','), '--plain'];
      for (const a of t.acceptance || []) args.push('--ac', a);
      backlog(args);
    }
    log('plan', { slug, msg: `${pl.tasks.length} tasks created (${changeName})` });
  }

// ---------- 3. BUILD (TDD loop with test + review gates) ----------
function snapshot(dir) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === 'package-lock.json') continue;
    const f = path.join(d, e.name);
    e.isDirectory() ? walk(f) : out.push(`FILE: ${path.relative(dir, f).replace(/\\/g, '/')}\n\`\`\`\n${read(f).slice(0, 6000)}\n\`\`\``);
  } };
  if (exists(dir)) walk(dir);
  return out.join('\n').slice(0, 24000);
}
function parseFiles(text) {
  const files = [];
  const re = /FILE:\s*`?([^\n`]+?)`?\s*\r?\n```[^\n]*\r?\n([\s\S]*?)\r?\n```/g;
  let m; while ((m = re.exec(text))) files.push({ rel: m[1].trim().replace(/\\/g, '/'), content: m[2] + '\n' });
  return files;
}
function applyFiles(dir, files, deps = declared(dir)) {
  const problems = [];
  for (const f of files) {
    try {
      if (/(^|\/)(package(-lock)?\.json)$/.test(f.rel)) { problems.push(`${f.rel}: do not write package files; list packages on a "DEPENDENCIES: a, b" line and the factory installs them`); continue; }
      const v = codeViolations(f.rel, f.content);
      if (/\.(mjs|js|cjs)$/.test(f.rel) && !/^public\//.test(f.rel)) {
        const und = undeclaredImports(f.content, deps);
        if (und.length) v.push(`${f.rel}: imports undeclared package(s) ${und.join(', ')}; add them to the DEPENDENCIES line`);
      }
      if (v.length) { problems.push(...v); continue; }
      const full = safeJoin(dir, f.rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, f.content);
    } catch (e) { problems.push(e.message); }
  }
  return problems;
}
const setStatus = (t, s) => backlog(['task', 'edit', t.id.replace(/\D/g, ''), '-s', s]);

// Escalation ladder: small model first, then the large (slow) model.
async function buildTask(slug, dir, task) {
  const idea = JSON.parse(read(path.join(paths.ideas, slug + '.json')));
  let feedback = '';
  const ladder = [...Array(cfg.build.attemptsSmall).fill('engineer'), ...Array(cfg.build.attemptsLarge).fill('engineerLarge')];
  for (let attempt = 1; attempt <= ladder.length; attempt++) {
    haltCheck();
    const role = ladder[attempt - 1];
    const prompt = `Product: ${idea.title}\n${idea.problem}\n${idea.human_constraints?.length ? 'HUMAN CONSTRAINTS (mandatory, override anything else):\n- ' + idea.human_constraints.join('\n- ') + '\n' : ''}\nTASK ${task.id}: ${task.title}\n${task.body}\n\nCurrent project files:\n${snapshot(dir) || '(empty)'}\n${feedback}`;
    const reply = await chat(role, persona('engineer') + '\n\n' + RULES(), prompt, { temperature: 0.2 + attempt * 0.1 });
    const files = parseFiles(reply);
    if (!files.length) { feedback = '\nYour last reply had no parsable FILE blocks. Follow the output format exactly.'; continue; }
    const dep = await ensureDeps(dir, slug, parseDependencies(reply));
    const depNote = dep.rejected.length ? '\nPackages rejected by the factory (choose a different standard package or built-in): ' + dep.rejected.map((r) => `${r.name} (${r.reason})`).join('; ') + '\n' : '';
    const problems = applyFiles(dir, files);
    if (depNote) problems.push(depNote);
    if (problems.length) { feedback = '\nRejected by guard, fix these:\n' + problems.join('\n'); log('guard', { slug, msg: problems.join(' | ') }); continue; }
    const t = runTests(dir);
    if (!t.ok) { feedback = `\nTests FAILED (attempt ${attempt}). Fix them:\n${t.out}`; log('tests-fail', { slug, msg: task.id + ' attempt ' + attempt }); continue; }
    const review = await chatJson('reviewer', persona('reviewer') + '\n\n' + RULES(),
      `Task: ${task.title}\n${task.body}\n\nFiles:\n${snapshot(dir)}\n\nTest output:\n${t.out}`);
    if (review.verdict !== 'pass') { feedback = '\nReviewer rejected:\n- ' + (review.issues || []).join('\n- '); log('review-fail', { slug, msg: feedback.slice(0, 200) }); continue; }
    return { ok: true, summary: review.summary };
  }
  return { ok: false, failure: feedback.slice(0, 3000) };
}

const commit = (dir, msg) => { git(dir, 'add', '-A'); git(dir, '-c', 'user.name=factory', '-c', 'user.email=factory@local', 'commit', '-qm', msg); };
const rollback = (dir) => { git(dir, 'reset', '-q', '--hard'); git(dir, 'clean', '-fdq'); };
const num = (t) => t.id.replace(/\D/g, '');
const depthOf = (t) => Math.max(0, ...t.labels.map((l) => (l.match(/^depth-(\d+)$/) || [, 0])[1]).map(Number));

// Ask the large model to rescope a failing task into smaller, independently testable subtasks.
async function split(slug, dir, task, failure) {
  const depth = depthOf(task) + 1;
  const out = await chatJson('planner', persona('splitter') + '\n\n' + RULES(),
    `TASK ${task.id}: ${task.title}\n${task.body}\n\nWhy it failed:\n${failure}\n\nCurrent project files:\n${snapshot(dir) || '(empty)'}`);
  const subs = (out.subtasks || []).slice(0, 4);
  if (subs.length < 2) return [];
  const ids = [];
  for (const [i, s] of subs.entries()) {
    const args = ['task', 'create', `${task.title} (${i + 1}/${subs.length}): ${s.title}`, '-d', `${s.description}\n\nFiles: ${(s.files || []).join(', ')}\nSplit from ${task.id}; ${out.note || ''}`,
      '-l', `${slug},depth-${depth}`, '-p', num(task), '--plain'];
    for (const a of s.acceptance || []) args.push('--ac', a);
    backlog(args);
  }
  const fresh = listTasks(slug).filter((t) => t.labels.includes(`depth-${depth}`) && t.status !== 'Done' && t.title.startsWith(task.title + ' ('));
  log('task-split', { slug, msg: `${task.id} -> ${fresh.map((t) => t.id).join(', ')}` });
  return fresh;
}

// Returns true when the task (or all its subtasks) is complete.
async function runTask(slug, dir, task) {
  haltCheck();
  setStatus(task, 'In Progress');
  const r = await buildTask(slug, dir, task);
  if (r.ok) {
    commit(dir, `${task.id}: ${task.title}`);
    backlog(['task', 'edit', num(task), '-s', 'Done', '--final-summary', r.summary || 'Implemented, tests green, reviewed.']);
    log('task-done', { slug, msg: task.id + ' ' + task.title });
    return true;
  }
  rollback(dir);
  if (depthOf(task) < cfg.build.maxSplitDepth) {
    const subs = await split(slug, dir, task, r.failure);
    if (subs.length) {
      let all = true;
      for (const s of subs) if (!(await runTask(slug, dir, s))) { all = false; break; }
      if (all) {
        backlog(['task', 'edit', num(task), '-s', 'Done', '--add-label', 'split', '--final-summary', 'Rescoped automatically into subtasks; all completed.']);
        return true;
      }
    }
  }
  backlog(['task', 'edit', num(task), '-s', 'To Do', '--add-label', 'blocked']);
  log('task-blocked', { slug, msg: task.id + ' exhausted all models and rescoping' });
  requestHuman('blocked-task', slug, [`${task.id} ${task.title} failed on small model, large model, and ${cfg.build.maxSplitDepth} levels of automatic rescoping.`, `Last failure: ${(r.failure || '').slice(0, 500)}`]);
  return false;
}

async function build(slug, label) {
  const dir = path.join(paths.products, slug);
  fs.mkdirSync(dir, { recursive: true });
  if (!exists(path.join(dir, '.git'))) { git(dir, 'init', '-q'); }
  ensureGitignore(dir);
  // Work left by an interrupted run is stashed (never discarded) so a stop-now can't poison the next task.
  if (git(dir, 'rev-parse', '--verify', '-q', 'HEAD').status === 0 && git(dir, 'status', '--porcelain').stdout.trim()) {
    git(dir, '-c', 'user.name=factory', '-c', 'user.email=factory@local', 'stash', 'push', '-u', '-m', 'factory-interrupted-' + Date.now());
    log('stash', { slug, msg: 'stashed uncommitted changes from an interrupted run' });
  }
  const scoped = () => listTasks(slug).filter((t) => !label || t.labels.includes(label));
  let done = 0;
  for (const task of scoped()) {
    if (task.status === 'Done' || task.labels.includes('blocked') || depthOf(task) > 0) continue;
    if (done >= cfg.build.maxTasksPerCycle) break;
    if (!(await runTask(slug, dir, task))) break;
    done++;
  }
  return scoped().filter((t) => depthOf(t) === 0).every((t) => t.status === 'Done');
}

// ---------- 4. RELEASE PACKAGE (human publishes) ----------
async function release(slug) {
  const dir = path.join(paths.products, slug);
  const idea = JSON.parse(read(path.join(paths.ideas, slug + '.json')));
  const out = await chatJson('pm', persona('release') + '\n\n' + RULES(), `${JSON.stringify(idea)}\n\nFiles:\n${snapshot(dir)}`);
  const verdict = denylistHit(JSON.stringify(out));
  if (verdict) { log('release-blocked', { slug, msg: 'denylist ' + verdict }); return; }
  fs.writeFileSync(path.join(dir, 'README.md'), out.readme);
  git(dir, 'add', '-A'); git(dir, '-c', 'user.name=factory', '-c', 'user.email=factory@local', 'commit', '-qm', 'docs: README');
  requestHuman('publish', slug, [`Listing copy: ${out.listing}`, `Pricing suggestion: ${out.pricing_suggestion}`, ...(out.human_steps || []).map((s) => 'HUMAN STEP: ' + s), `Product dir: products/${slug}`]);
  const idf = path.join(paths.ideas, slug + '.json'); const idea2 = JSON.parse(read(idf)); idea2.status = 'ready-for-human'; fs.writeFileSync(idf, JSON.stringify(idea2, null, 2));
}

// ---------- scrap: delete everything related to one idea/product ----------
function scrap(slug, confirmed) {
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) throw new Error('usage: scrap <slug> [--yes]  (slug = lowercase letters, digits, hyphens)');
  const targets = [];
  const add = (f) => exists(f) && targets.push(f);
  add(path.join(paths.ideas, slug + '.json'));
  add(path.join(paths.openspec, 'changes', slug));
  add(path.join(paths.openspec, 'changes', 'archive', slug));
  add(path.join(paths.products, slug));
  add(paths.p('iterations', slug));
  const chg = paths.p('openspec', 'changes');
  if (exists(chg)) for (const d of fs.readdirSync(chg)) if (new RegExp(`^${slug}-iter-\\d+$`).test(d)) add(path.join(chg, d));
  if (exists(paths.approvals)) for (const f of fs.readdirSync(paths.approvals)) if (f.includes(`-${slug}-`)) add(path.join(paths.approvals, f));
  for (const d of ['tasks', 'completed', path.join('archive', 'tasks')]) {
    const dir = paths.p('backlog', d);
    if (!exists(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      const fm = (read(path.join(dir, f)).match(/^---\r?\n([\s\S]*?)\r?\n---/) || [, ''])[1];
      const labels = ((fm.match(/^labels:\s*(.*)$/m) || [, ''])[1].match(/[\w-]+/g) || []);
      if (labels.includes(slug)) add(path.join(dir, f));
    }
  }
  if (!targets.length) { console.log(`Nothing found for "${slug}".`); return; }
  console.log(`${confirmed ? 'Deleting' : 'Would delete'}:\n` + targets.map((t) => '  ' + path.relative(ROOT, t)).join('\n'));
  if (!confirmed) { console.log('\nRe-run with --yes to delete. (Stop any running cycle/loop first: node factory/cli.mjs halt)'); return; }
  const failed = [];
  for (const t of targets) {
    try { fs.rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) { failed.push(`${path.relative(ROOT, t)} (${e.code})`); }
  }
  log('scrapped', { slug, msg: `${targets.length - failed.length}/${targets.length} items removed` });
  if (failed.length) console.log('\nCould not delete (in use by another process? close terminals/editors there and retry):\n  ' + failed.join('\n  '));
  else console.log('\nDone. The ledger (factory/state/ledger.jsonl) is kept as an audit trail.');
}

// ---------- human decision on an idea ----------
function approve(slug, args) {
  const f = path.join(paths.ideas, slug + '.json');
  if (!slug || !exists(f)) throw new Error('usage: approve <slug> [--note "constraint"]... (idea must exist in ideas/)');
  const idea = JSON.parse(read(f));
  const notes = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--note' && args[i + 1]) notes.push(args[++i]);
  if (idea.status === 'planned' || idea.status === 'ready-for-human') throw new Error(`already ${idea.status}; scrap it first to restart`);
  idea.human_override = { at: new Date().toISOString(), previous_status: idea.status, previous_compliance: idea.compliance };
  idea.human_constraints = [...(idea.human_constraints || []), ...notes];
  idea.status = 'approved';
  fs.writeFileSync(f, JSON.stringify(idea, null, 2));
  for (const a of fs.readdirSync(paths.approvals).filter((x) => x.includes(`-${slug}-needs-human`))) fs.rmSync(path.join(paths.approvals, a));
  log('human-approved', { slug, msg: `${slug} approved by human with ${notes.length} constraint(s)` });
  console.log(`Approved ${slug}. Constraints for the team:\n${notes.map((n) => '  - ' + n).join('\n') || '  (none)'}\nNext: node factory/cli.mjs plan ${slug}   (or run: build ${slug} after planning)`);
}
function reject(slug) {
  const f = path.join(paths.ideas, slug + '.json');
  const idea = JSON.parse(read(f)); idea.status = 'rejected'; fs.writeFileSync(f, JSON.stringify(idea, null, 2));
  log('human-rejected', { slug, msg: slug });
}

// ---------- 5. ITERATE: evaluate -> plan next increment -> build -> repeat ----------
const stateFile = (slug) => paths.p('iterations', slug, 'state.json');
const iterPath = (slug, n, f) => paths.p('iterations', slug, `iter-${n}`, f);
const loadIdea = (slug) => {
  const f = path.join(paths.ideas, slug + '.json');
  if (!slug || !exists(f)) throw new Error(`unknown idea "${slug}"`);
  return JSON.parse(read(f));
};
const loadState = (slug) => (exists(stateFile(slug)) ? JSON.parse(read(stateFile(slug))) : { count: 0, current: null, history: [] });
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2)); };
const parseNotes = (args) => { const n = []; for (let i = 0; i < args.length; i++) if (args[i] === '--note' && args[i + 1]) n.push(args[++i]); return n; };
const flagVal = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const iterLabel = (t) => t.labels.some((l) => /^iter-\d+$/.test(l));

function requireBuilt(slug) {
  loadIdea(slug);
  const open = listTasks(slug).filter((t) => depthOf(t) === 0 && !iterLabel(t) && t.status !== 'Done');
  if (!exists(path.join(paths.products, slug)) || !listTasks(slug).length) throw new Error(`${slug} has not been planned/built yet`);
  if (open.length) throw new Error(`initial build not finished (${open.length} open task(s)); run: build ${slug}`);
}

async function evaluate(slug, n) {
  const dir = path.join(paths.products, slug);
  const idea = loadIdea(slug);
  const mech = await mechanicalEval(dir);
  const st = loadState(slug);
  const history = st.history.map((h) => `iteration ${h.n}: ${h.theme} (score ${h.score}, ${h.done}/${h.tasks} tasks done)`).join('\n') || 'none (this is the first evaluation)';
  const open = listTasks(slug).filter((t) => t.status !== 'Done').map((t) => `${t.id} ${t.title} [${t.labels.includes('blocked') ? 'BLOCKED' : t.status}]`).join('\n') || 'none';
  const smoke = mech.smoke.checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.name} ${c.detail}`).join('\n');
  const hand = [];
  const srcText = fs.existsSync(path.join(dir, 'src')) ? fs.readdirSync(path.join(dir, 'src'), { recursive: true }).filter((f) => /\.(mjs|js)$/.test(f)).map((f) => ({ f, t: read(path.join(dir, 'src', f)) })) : [];
  for (const [re, what] of [[/createHmac|createSign|createCipheriv|pbkdf2|scryptSync/, 'hand-rolled crypto/password/token code'], [/createServer\s*\(/, 'raw node:http server instead of a web framework'], [/set-cookie|Set-Cookie/, 'hand-rolled cookie/session handling'], [/JSON\.parse\(.*body|req\.on\(['"]data/, 'manual request-body parsing/validation']])
    for (const s of srcText) if (re.test(s.t)) { hand.push(`${s.f}: ${what}`); break; }
  const prompt = `PRODUCT: ${idea.title} - ${idea.tagline || ''}\nDECLARED DEPENDENCIES: ${declared(dir).join(', ') || 'none'}\nPOSSIBLE HAND-ROLLED CODE (heuristic; verify): ${hand.join(' | ') || 'none detected'}\nProblem: ${idea.problem}\nAudience: ${idea.audience}\nMonetization: ${idea.monetization}\n` +
    `Planned mvp_scope: ${JSON.stringify(idea.mvp_scope)}\nphase2: ${JSON.stringify(idea.phase2)}\nphase3: ${JSON.stringify(idea.phase3)}\n` +
    (idea.human_constraints?.length ? `HUMAN CONSTRAINTS:\n- ${idea.human_constraints.join('\n- ')}\n` : '') +
    `\nEARLIER ITERATIONS:\n${history}\n\nOPEN/BLOCKED TASKS:\n${open}\n\nMECHANICAL RESULTS\nTests ${mech.tests.ok ? 'PASSED' : 'FAILED'}:\n${mech.tests.out.slice(-1500)}\nSmoke test:\n${smoke}\nServer stderr: ${mech.smoke.stderr || '(none)'}\nStats: ${JSON.stringify(mech.stats)}\n\nFILE TREE:\n${tree(dir)}\n\nSOURCE:\n${snapshot(dir)}`;
  const ev = await chatJson('evaluator', persona('evaluator') + '\n\n' + RULES(), prompt);
  ev.quality_score = Number(ev.quality_score) || 0;
  ev.mechanical = { tests_ok: mech.tests.ok, smoke: mech.smoke.checks, stats: mech.stats };
  log('evaluate', { slug, msg: `iteration ${n}: score ${ev.quality_score}/10, tests ${mech.tests.ok ? 'pass' : 'FAIL'}, smoke ${mech.smoke.checks.filter((c) => !c.ok).length} failing` });
  return ev;
}

async function planIteration(slug, n, ev, feedback) {
  const idea = loadIdea(slug);
  const max = cfg.iterate.maxTasksPerIteration;
  const prompt = `Plan iteration ${n}. Maximum tasks: ${max}. Task titles must start with "I${n}: ".\n\nPRODUCT: ${idea.title}\nProblem: ${idea.problem}\nphase2: ${JSON.stringify(idea.phase2)}\nphase3: ${JSON.stringify(idea.phase3)}\n` +
    (idea.human_constraints?.length ? `HUMAN CONSTRAINTS (mandatory):\n- ${idea.human_constraints.join('\n- ')}\n` : '') +
    (feedback ? `\nHUMAN/COMPLIANCE FEEDBACK ON THE PREVIOUS PLAN (mandatory):\n${feedback}\n` : '') +
    `\nEARLIER ITERATIONS:\n${loadState(slug).history.map((h) => `${h.n}: ${h.theme}`).join('\n') || 'none'}\n\nEVALUATION:\n${JSON.stringify({ ...ev, mechanical: { tests_ok: ev.mechanical.tests_ok, failing_smoke: ev.mechanical.smoke.filter((c) => !c.ok), stats: ev.mechanical.stats } }, null, 1)}`;
  const pl = await chatJson('planner', persona('iteration-planner') + '\n\n' + RULES(), prompt);
  pl.tasks = (Array.isArray(pl.tasks) ? pl.tasks : []).slice(0, max).map((t) => ({ ...t, title: /^I\d+:/.test(t.title) ? t.title : `I${n}: ${t.title}` }));
  pl.converged = !!pl.converged || !pl.tasks.length;
  pl.theme = pl.theme || `iteration ${n}`;
  if (!Array.isArray(pl.requirements) || !pl.requirements.length) pl.requirements = [{ name: pl.theme, text: `The system SHALL deliver: ${pl.rationale || pl.theme}`, scenarios: [] }];
  const hit = denylistHit(JSON.stringify(pl));
  const verdict = hit ? { approved: false, violations: [`denylist match: ${hit}`] }
    : await chatJson('compliance', persona('compliance') + '\n\n' + RULES(), JSON.stringify({ product: idea.title, constraints: idea.human_constraints || [], iteration_plan: { theme: pl.theme, rationale: pl.rationale, tasks: pl.tasks.map((t) => ({ title: t.title, description: t.description })) } }));
  return { plan: pl, verdict };
}

// Returns 'done' | 'partial' | 'converged' | 'awaiting' | 'blocked'. Resumable: state is persisted after every phase.
async function runIteration(slug, { planOnly = false } = {}) {
  setScope(slug);
  requireBuilt(slug);
  const dir = path.join(paths.products, slug);
  const st = loadState(slug);
  if (!st.current || st.current.phase === 'done') { st.current = { n: st.count + 1, phase: 'start', startedAt: new Date().toISOString() }; writeJson(stateFile(slug), st); }
  const n = st.current.n;
  const save = (phase, extra = {}) => { st.current = { ...st.current, phase, ...extra }; writeJson(stateFile(slug), st); };
  const phase = () => st.current.phase;
  if (phase() === 'awaiting-approval') { console.log(`Iteration ${n} plan is awaiting your decision: iterate-approve ${slug} | iterate-reject ${slug} --note "..."`); return 'awaiting'; }
  log('iteration', { slug, msg: `iteration ${n} starting at phase "${phase()}"` });

  if (phase() === 'start') {
    writeJson(iterPath(slug, n, 'evaluation.json'), await evaluate(slug, n));
    save('evaluated');
  }
  if (phase() === 'evaluated') {
    const ev = JSON.parse(read(iterPath(slug, n, 'evaluation.json')));
    let feedback = st.current.feedback || '', res;
    for (let attempt = 0; attempt < 2; attempt++) {
      haltCheck();
      res = await planIteration(slug, n, ev, feedback);
      if (res.verdict.approved) break;
      feedback += `\nCompliance rejected the previous plan: ${(res.verdict.violations || []).join('; ')}. Revise it.`;
    }
    writeJson(iterPath(slug, n, 'plan.json'), res.plan);
    if (!res.verdict.approved) {
      requestHuman('iteration-compliance', slug, [`Iteration ${n} plan was rejected twice by compliance: ${(res.verdict.violations || []).join('; ')}`, `Plan: iterations/${slug}/iter-${n}/plan.json`, `Re-run: iterate ${slug} (re-plans), or give guidance with a constraint via approve ${slug} --note "..."`]);
      return 'blocked';
    }
    if (res.plan.converged) { finishIteration(slug, st, n, ev, res.plan, [], dir); return 'converged'; }
    save('planned', { feedback: '' });
  }
  if (phase() === 'planned') {
    const pl = JSON.parse(read(iterPath(slug, n, 'plan.json')));
    if (planOnly && !st.current.approved) {
      requestHuman('iteration-plan', slug, [`Iteration ${n} theme: ${pl.theme}`, `Why: ${pl.rationale}`, ...pl.tasks.map((t) => `Task: ${t.title}`), `Edit iterations/${slug}/iter-${n}/plan.json to change it, then: node factory/cli.mjs iterate-approve ${slug} [--note "constraint"]`, `Or send it back: node factory/cli.mjs iterate-reject ${slug} --note "feedback"`]);
      save('awaiting-approval');
      console.log(`Iteration ${n} planned: "${pl.theme}" (${pl.tasks.length} tasks). Not acting until you run iterate-approve ${slug}.`);
      return 'awaiting';
    }
    if (!listTasks(slug).some((t) => t.labels.includes(`iter-${n}`))) materialize(slug, pl, `${slug}-iter-${n}`, [`iter-${n}`]);
    save('building');
  }
  if (phase() === 'building') {
    await build(slug, `iter-${n}`);
    const ev = JSON.parse(read(iterPath(slug, n, 'evaluation.json')));
    const pl = JSON.parse(read(iterPath(slug, n, 'plan.json')));
    const tasks = listTasks(slug).filter((t) => t.labels.includes(`iter-${n}`));
    finishIteration(slug, st, n, ev, pl, tasks, dir);
    return tasks.every((t) => t.status === 'Done') ? 'done' : 'partial';
  }
  return 'done';
}

function finishIteration(slug, st, n, ev, pl, tasks, dir) {
  const done = tasks.filter((t) => t.status === 'Done').length;
  const lines = tasks.map((t) => `- ${t.status === 'Done' ? '[x]' : '[ ] (blocked)'} ${t.title}`);
  const date = new Date().toISOString().slice(0, 10);
  if (tasks.length) {
    const cl = path.join(dir, 'CHANGELOG.md');
    fs.appendFileSync(cl, `${exists(cl) ? '' : '# Changelog\n'}\n## Iteration ${n} - ${pl.theme} (${date})\n${lines.join('\n')}\n`);
    git(dir, 'add', '-A'); git(dir, '-c', 'user.name=factory', '-c', 'user.email=factory@local', 'commit', '-qm', `iteration ${n}: ${pl.theme}`);
    git(dir, 'tag', '-f', `iter-${n}`);
  }
  fs.writeFileSync(iterPath(slug, n, 'summary.md'), `# Iteration ${n}: ${pl.theme}\n\nEvaluation score before: ${ev.quality_score}/10\n\n${ev.summary || ''}\n\n${pl.converged ? 'The planner judged the product converged: no worthwhile changes remain.\n' : `Why: ${pl.rationale}\n\n${lines.join('\n')}\n`}`);
  st.history.push({ n, theme: pl.converged ? 'converged' : pl.theme, score: ev.quality_score, tasks: tasks.length, done, blocked: tasks.length - done, converged: !!pl.converged, at: new Date().toISOString() });
  st.count = n;
  st.current = { ...st.current, phase: 'done' };
  writeJson(stateFile(slug), st);
  log('iteration-done', { slug, msg: `iteration ${n} "${pl.theme}": ${done}/${tasks.length} tasks done, score before ${ev.quality_score}/10` });
}

// mode 1: iterate <slug> [--count N]      mode 2: --plan-only      mode 3: --auto [--max N]
async function iterateLoop(slug, { count = 1, planOnly = false, auto = false, max } = {}) {
  setScope(slug);
  const since = Date.now();
  const limit = auto ? (max || cfg.iterate.maxIterations) : count;
  const stopAfter = () => ['all', slug].some((k) => { const f = stopFile('stop-after', k); return exists(f) && fs.statSync(f).mtimeMs >= since - 1000; });
  let ran = 0, partial = 0;
  while (ran < limit) {
    haltCheck();
    if (stopAfter()) { log('iterate-stop', { slug, msg: 'stop-after requested; stopping at iteration boundary' }); console.log('Stopped at iteration boundary as requested.'); break; }
    const r = await runIteration(slug, { planOnly });
    console.log(`Iteration result: ${r}`);
    if (r === 'awaiting' || r === 'blocked') break;
    ran++;
    if (r === 'converged') { console.log('Planner judged the product converged. Stopping.'); break; }
    partial = r === 'partial' ? partial + 1 : 0;
    if (partial >= 2) { requestHuman('iteration-stalled', slug, ['Two consecutive iterations left blocked tasks; auto-iteration paused to avoid burning compute.', 'Review blocked tasks in the backlog, then run: iterate ' + slug]); break; }
    if (planOnly) break;
  }
  if (auto && ran >= limit) log('iterate-limit', { slug, msg: `reached max of ${limit} iterations for this run` });
}

async function iterateApprove(slug, args) {
  const st = loadState(slug);
  if (st.current?.phase !== 'awaiting-approval') throw new Error(`no iteration plan awaiting approval for ${slug}`);
  const notes = parseNotes(args);
  if (notes.length) { const idea = loadIdea(slug); idea.human_constraints = [...(idea.human_constraints || []), ...notes]; writeJson(path.join(paths.ideas, slug + '.json'), idea); }
  for (const a of fs.readdirSync(paths.approvals).filter((x) => x.includes(`-${slug}-iteration-plan`))) fs.rmSync(path.join(paths.approvals, a));
  st.current = { ...st.current, phase: 'planned', approved: true };
  writeJson(stateFile(slug), st);
  log('iteration-approved', { slug, msg: `iteration ${st.current.n} approved by human` });
  await iterateLoop(slug, args.includes('--auto') ? { auto: true, max: Number(flagVal(args, '--max')) || undefined } : { count: 1 });
}
function iterateReject(slug, args) {
  const st = loadState(slug);
  if (st.current?.phase !== 'awaiting-approval') throw new Error(`no iteration plan awaiting approval for ${slug}`);
  for (const a of fs.readdirSync(paths.approvals).filter((x) => x.includes(`-${slug}-iteration-plan`))) fs.rmSync(path.join(paths.approvals, a));
  st.current = { ...st.current, phase: 'evaluated', feedback: parseNotes(args).join('\n') || 'The human rejected the plan; propose a different one.', approved: false };
  writeJson(stateFile(slug), st);
  log('iteration-rejected', { slug, msg: `iteration ${st.current.n} plan sent back` });
  console.log('Plan discarded. It will be re-planned with your feedback on the next: iterate ' + slug + ' [--plan-only]');
}
function iterateStop(target, now) {
  if (!target) throw new Error('usage: iterate-stop <slug|all> [--now]');
  const f = stopFile(now ? 'stop-now' : 'stop-after', target);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, new Date().toISOString());
  log('iterate-stop-requested', { slug: target, msg: now ? 'stop NOW (at next checkpoint, before the next model call)' : 'stop after current iteration' });
  console.log(now ? `Stop requested for ${target}: the run exits at its next checkpoint (an in-flight model call may finish first). Unfinished work is stashed on resume; state is resumable.` : `Stop requested for ${target}: the loop finishes its current iteration, then stops.`);
}

// ---------- orchestration ----------
async function afterRelease(slug) {
  const m = cfg.iterate?.afterRelease || 'manual';
  if (m === 'plan') await iterateLoop(slug, { planOnly: true });
  else if (m === 'auto') await iterateLoop(slug, { auto: true });
}
async function cycle(hint) {
  try { await scout(false); } catch (e) { log('scout-error', { msg: e.message }); }
  const slug = await ideate(hint);
  if (!slug) return;
  await plan(slug);
  if (await build(slug)) { await release(slug); await afterRelease(slug); }
}
function status() {
  const ideas = exists(paths.ideas) ? fs.readdirSync(paths.ideas).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(read(path.join(paths.ideas, f)))) : [];
  for (const i of ideas) {
    const t = listTasks(i.name);
    const it = loadState(i.name);
    const itx = it.count || it.current ? `  iter ${it.count}${it.current && it.current.phase !== 'done' ? ` (#${it.current.n}: ${it.current.phase})` : ''}` : '';
    console.log(`${i.name.padEnd(30)} ${i.status.padEnd(16)} tasks ${t.filter((x) => x.status === 'Done').length}/${t.length}${itx}`);
  }
  const pend = exists(paths.approvals) ? fs.readdirSync(paths.approvals).filter((f) => f.endsWith('.md')) : [];
  console.log(`\nPending human items: ${pend.length}${pend.length ? '\n  ' + pend.join('\n  ') : ''}`);
}
async function loop() {
  let today = '', n = 0;
  for (;;) {
    haltCheck();
    const d = new Date().toISOString().slice(0, 10);
    if (d !== today) { today = d; n = 0; }
    if (n < cfg.loop.maxCyclesPerDay) { n++; try { await cycle(); } catch (e) { log('cycle-error', { msg: e.message }); } }
    await new Promise((r) => setTimeout(r, cfg.loop.sleepMinutes * 60000));
  }
}

const [cmd, arg, ...rest] = process.argv.slice(2);
const cmds = {
  research: () => research(true).then((r) => r.opportunities.forEach((o) => console.log(`- [${o.demand_strength}] ${o.saas_concept}\n    ${o.evidence.join(' ')}`))),
  ideate: () => ideate(arg ? [arg, ...rest].join(' ') : ''),
  plan: () => plan(arg), build: () => build(arg), release: () => release(arg),
  cycle: () => cycle(arg ? [arg, ...rest].join(' ') : ''), loop, status,
  approve: () => approve(arg, rest),
  reject: () => reject(arg),
  scrap: () => scrap(arg, rest.includes('--yes') || arg === '--yes'),
  iterate: () => iterateLoop(arg, {
    count: Number(flagVal(rest, '--count')) || 1, planOnly: rest.includes('--plan-only'),
    auto: rest.includes('--auto'), max: Number(flagVal(rest, '--max')) || undefined,
  }),
  'iterate-approve': () => iterateApprove(arg, rest),
  'iterate-reject': () => iterateReject(arg, rest),
  'iterate-stop': () => iterateStop(arg, rest.includes('--now')),
  scout: () => scout(true).then(() => toolsList()),
  tools: () => toolsList(),
  'tools-approve': () => toolsDecide(arg, 'approve', rest),
  'tools-reject': () => toolsDecide(arg, 'reject'),
  halt: () => fs.writeFileSync(path.join(ROOT, 'HALT'), 'stop'),
  resume: () => fs.rmSync(path.join(ROOT, 'HALT'), { force: true }),
};
if (!cmds[cmd]) { console.log('usage: node factory/cli.mjs <research|ideate [hint]|plan <slug>|build <slug>|release <slug>|cycle [hint]|loop|status|approve|reject|scrap <slug> [--yes]|iterate <slug> [--count N|--plan-only|--auto [--max N]]|iterate-approve <slug>|iterate-reject <slug>|iterate-stop <slug|all> [--now]|scout|tools|tools-approve <id> [--url U --roles r1,r2]|tools-reject <id>|halt|resume>'); process.exit(1); }
Promise.resolve(cmds[cmd]()).catch((e) => { log('fatal', { msg: e.stack }); process.exit(1); });
