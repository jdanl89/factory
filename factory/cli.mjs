#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ROOT, cfg, rulesText, persona, log, haltCheck, denylistHit, slugify, safeJoin, codeViolations,
  chat, chatJson, backlog, listTasks, runTests, git, paths, requestHuman,
} from './lib/core.mjs';

const RULES = () => `GOLDEN RULES:\n${rulesText()}`;
const read = (f) => fs.readFileSync(f, 'utf8');
const exists = fs.existsSync;

// ---------- 1. IDEATE ----------
async function ideate(hint = '') {
  haltCheck();
  const existing = exists(paths.ideas) ? fs.readdirSync(paths.ideas).map((f) => f.replace('.json', '')) : [];
  const idea = await chatJson('strategist', persona('strategist') + '\n\n' + RULES(),
    `Existing ideas (do not duplicate): ${existing.join(', ') || 'none'}.\n${hint ? 'Human hint: ' + hint : 'Choose freely.'}`);
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
  const cap = slugify(pl.capability || slug);
  const dir = path.join(paths.openspec, 'changes', slug);
  fs.mkdirSync(path.join(dir, 'specs', cap), { recursive: true });
  fs.writeFileSync(path.join(dir, 'proposal.md'), `## Why\n${pl.why}\n\n## What Changes\n${pl.what_changes}\n\n## Impact\n- Affected specs: ${cap}\n- Product: products/${slug}\n`);
  fs.writeFileSync(path.join(dir, 'design.md'), `## Design\n${pl.design}\n`);
  fs.writeFileSync(path.join(dir, 'tasks.md'), '## 1. Implementation\n' + pl.tasks.map((t, i) => `- [ ] 1.${i + 1} ${t.title}`).join('\n') + '\n');
  const specs = pl.requirements.map((r) => `### Requirement: ${r.name}\n${/\b(SHALL|MUST)\b/.test(r.text) ? r.text : 'The system SHALL ' + r.text}\n\n` +
    (r.scenarios?.length ? r.scenarios : [{ name: 'Basic', when: 'used normally', then: 'it works as described' }])
      .map((s) => `#### Scenario: ${s.name}\n- **WHEN** ${s.when}\n- **THEN** ${s.then}\n`).join('\n')).join('\n');
  fs.writeFileSync(path.join(dir, 'specs', cap, 'spec.md'), `## ADDED Requirements\n${specs}`);
  const v = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', '@fission-ai', 'openspec', 'bin', 'openspec.js'), 'validate', slug, '--type', 'change'], { cwd: ROOT, encoding: 'utf8' });
  log('openspec-validate', { slug, msg: (v.status === 0 ? 'valid' : 'INVALID ' + (v.stdout + v.stderr).slice(0, 300)) });
  for (const t of pl.tasks) {
    const desc = `${t.description}\n\nFiles: ${(t.files || []).join(', ')}\nSpec: openspec/changes/${slug}`;
    const args = ['task', 'create', t.title, '-d', desc, '-l', slug, '--plain'];
    for (const a of t.acceptance || []) args.push('--ac', a);
    backlog(args);
  }
  idea.status = 'planned';
  fs.writeFileSync(ideaFile, JSON.stringify(idea, null, 2));
  log('plan', { slug, msg: `${pl.tasks.length} tasks created` });
}

// ---------- 3. BUILD (TDD loop with test + review gates) ----------
function snapshot(dir) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
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
function applyFiles(dir, files) {
  const problems = [];
  for (const f of files) {
    try {
      const v = codeViolations(f.rel, f.content);
      if (v.length) { problems.push(...v); continue; }
      const full = safeJoin(dir, f.rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, f.content);
    } catch (e) { problems.push(e.message); }
  }
  return problems;
}
const setStatus = (t, s) => backlog(['task', 'edit', t.id.replace(/\D/g, ''), '-s', s]);

async function buildTask(slug, dir, task) {
  const idea = JSON.parse(read(path.join(paths.ideas, slug + '.json')));
  let feedback = '';
  for (let attempt = 1; attempt <= cfg.build.maxAttemptsPerTask; attempt++) {
    haltCheck();
    const role = attempt === cfg.build.maxAttemptsPerTask ? 'engineer' : 'engineer';
    const prompt = `Product: ${idea.title}\n${idea.problem}\n\nTASK ${task.id}: ${task.title}\n${task.body}\n\nCurrent project files:\n${snapshot(dir) || '(empty)'}\n${feedback}`;
    const reply = await chat(role, persona('engineer') + '\n\n' + RULES(), prompt, { temperature: 0.2 + attempt * 0.1 });
    const files = parseFiles(reply);
    if (!files.length) { feedback = '\nYour last reply had no parsable FILE blocks. Follow the output format exactly.'; continue; }
    const problems = applyFiles(dir, files);
    if (problems.length) { feedback = '\nRejected by guard, fix these:\n' + problems.join('\n'); log('guard', { slug, msg: problems.join(' | ') }); continue; }
    const t = runTests(dir);
    if (!t.ok) { feedback = `\nTests FAILED (attempt ${attempt}). Fix them:\n${t.out}`; log('tests-fail', { slug, msg: task.id + ' attempt ' + attempt }); continue; }
    const review = await chatJson('reviewer', persona('reviewer') + '\n\n' + RULES(),
      `Task: ${task.title}\n${task.body}\n\nFiles:\n${snapshot(dir)}\n\nTest output:\n${t.out}`);
    if (review.verdict !== 'pass') { feedback = '\nReviewer rejected:\n- ' + (review.issues || []).join('\n- '); log('review-fail', { slug, msg: feedback.slice(0, 200) }); continue; }
    return { ok: true, summary: review.summary };
  }
  return { ok: false };
}

async function build(slug) {
  const dir = path.join(paths.products, slug);
  fs.mkdirSync(dir, { recursive: true });
  if (!exists(path.join(dir, '.git'))) { git(dir, 'init', '-q'); }
  let done = 0;
  for (const task of listTasks(slug)) {
    if (task.status === 'Done' || task.labels.includes('blocked')) continue;
    if (done >= cfg.build.maxTasksPerCycle) break;
    haltCheck();
    setStatus(task, 'In Progress');
    const r = await buildTask(slug, dir, task);
    if (r.ok) {
      git(dir, 'add', '-A'); git(dir, '-c', 'user.name=factory', '-c', 'user.email=factory@local', 'commit', '-qm', `${task.id}: ${task.title}`);
      backlog(['task', 'edit', task.id.replace(/\D/g, ''), '-s', 'Done', '--final-summary', r.summary || 'Implemented, tests green, reviewed.']);
      done++; log('task-done', { slug, msg: task.id + ' ' + task.title });
    } else {
      backlog(['task', 'edit', task.id.replace(/\D/g, ''), '-s', 'To Do', '-l', 'blocked']);
      log('task-blocked', { slug, msg: task.id + ' needs human/larger-model help' });
      requestHuman('blocked-task', slug, [`${task.id} ${task.title} failed ${cfg.build.maxAttemptsPerTask} attempts. Consider rescoping or using a stronger model.`]);
      break;
    }
  }
  return listTasks(slug).every((t) => t.status === 'Done');
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

// ---------- orchestration ----------
async function cycle(hint) {
  const slug = await ideate(hint);
  if (!slug) return;
  await plan(slug);
  if (await build(slug)) await release(slug);
}
function status() {
  const ideas = exists(paths.ideas) ? fs.readdirSync(paths.ideas).map((f) => JSON.parse(read(path.join(paths.ideas, f)))) : [];
  for (const i of ideas) {
    const t = listTasks(i.name);
    console.log(`${i.name.padEnd(30)} ${i.status.padEnd(16)} tasks ${t.filter((x) => x.status === 'Done').length}/${t.length}`);
  }
  const pend = exists(paths.approvals) ? fs.readdirSync(paths.approvals) : [];
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
  ideate: () => ideate(arg ? [arg, ...rest].join(' ') : ''),
  plan: () => plan(arg), build: () => build(arg), release: () => release(arg),
  cycle: () => cycle(arg ? [arg, ...rest].join(' ') : ''), loop, status,
  halt: () => fs.writeFileSync(path.join(ROOT, 'HALT'), 'stop'),
  resume: () => fs.rmSync(path.join(ROOT, 'HALT'), { force: true }),
};
if (!cmds[cmd]) { console.log('usage: node factory/cli.mjs <ideate [hint]|plan <slug>|build <slug>|release <slug>|cycle [hint]|loop|status|halt|resume>'); process.exit(1); }
Promise.resolve(cmds[cmd]()).catch((e) => { log('fatal', { msg: e.stack }); process.exit(1); });
