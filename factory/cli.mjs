#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ROOT, cfg, rulesText, principles, platformText, persona, log, haltCheck, denylistHit, slugify, safeJoin, codeViolations,
  chat, chatJson, backlog, listTasks, runTests, git, paths, requestHuman, setScope, stopFile,
} from './lib/core.mjs';
import { parseSpec, specsFor, blockedReason, readUsage } from './lib/providers.mjs';
import { failScore, prioritize, lessons } from './lib/iterate.mjs';
import { mechanicalEval, tree, ensureGitignore } from './lib/evaluate.mjs';
import { runQualityGates, detectProfile, ensureCiWorkflow, ensureEditorConfig, ensureDependabot } from './lib/quality.mjs';
import { ensureDeps, ensureNodeProject, parseDependencies, declared, undeclaredImports, preferredText } from './lib/deps.mjs';
import { scout, toolsList, toolsDecide } from './lib/scout.mjs';
import { gatherSignals, loadFreshResearch, saveResearch, deepRead, sourceText, verifyQuotes, marketCheck, opportunityScore } from './lib/research.mjs';

const RULES = () => `GOLDEN RULES:\n${rulesText()}\n\n${principles()}\n${platformText()}\n${preferredText()}`;
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
  const digest = signals.map((s, i) => `${i + 1}. [${s.source}${s.lens ? ' | lens: ' + s.lens : ''}] ${s.title} | ${s.text} | score ${s.score}, ${s.comments} comments | ${s.url}`).join('\n');
  const out = await chatJson('analyst', persona('analyst') + '\n\n' + RULES(), `Signals:\n${digest}`);
  const known = new Set(signals.map((s) => s.url));
  const opps = (out.opportunities || []).map((o) => ({ ...o, evidence: (o.evidence || []).filter((u) => known.has(u)), total: opportunityScore(o) })).filter((o) => o.evidence.length)
    .sort((a, b) => b.total - a.total);
  if (!opps.length) throw new Error('analyst returned no evidence-backed opportunities');
  const res = { at: new Date().toISOString(), signals, opportunities: opps };
  saveResearch(res);
  log('research', { msg: `${opps.length} evidence-backed opportunities` });
  return res;
}

// ---------- 1. IDEATE ----------
// Deep-read the sources behind the top opportunities and turn each into a verified needs brief.
async function buildBriefs(r) {
  const ic = cfg.ideation || {};
  const briefs = [];
  for (const o of r.opportunities.slice(0, ic.briefCount ?? 4)) {
    haltCheck();
    const sources = [];
    for (const u of o.evidence.slice(0, 2)) { const d = await deepRead(u); if (d) sources.push(d); }
    if (!sources.length) { log('ideate', { msg: `skip "${o.saas_concept}": no readable source text` }); continue; }
    const text = sources.map((d, i) => `SOURCE ${i + 1} (${d.host}) ${d.url}\n${sourceText(d)}`).join('\n\n').slice(0, 11000);
    let b;
    try { b = await chatJson('analyst', persona('needs') + '\n\n' + RULES(), `Analyst's first-pass concept (may be wrong; trust the sources over it): ${o.saas_concept}\nEvidence lenses: ${(o.lenses || []).join(", ") || "general"}. Sources may be a discussion, a revenue/launch post, a shutdown or repricing story, or a trending project README; for those, quote the text that shows the demand, payment or gap.\n\n${text}`); }
    catch (e) { log('ideate', { msg: `needs analysis failed: ${e.message}` }); continue; }
    b.user_quotes = verifyQuotes(b.user_quotes, sources.map(sourceText));
    if (!b.user_quotes.length) { log('ideate', { msg: `drop "${o.saas_concept}": no verifiable user quotes` }); continue; }
    if (b.demand_type === 'not-a-product') { log('ideate', { msg: `drop "${o.saas_concept}": ${b.not_a_product_reason || 'not a product'}` }); continue; }
    b.sources = sources.map((d) => d.url);
    b.alternatives = ic.marketCheck === false ? [] : await marketCheck(b.search_terms).catch(() => []);
    briefs.push(b);
  }
  return briefs;
}

async function ideate(hint = '') {
  haltCheck();
  const ic = cfg.ideation || {};
  const existing = exists(paths.ideas) ? fs.readdirSync(paths.ideas).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')) : [];
  const r = await research();
  const briefs = await buildBriefs(r);
  if (!briefs.length) throw new Error('no opportunity survived deep reading; refusing to guess what users want');
  log('ideate', { msg: `${briefs.length} verified needs briefs` });
  const numbered = briefs.map((b, i) => ({ id: i, ...b }));
  let idea, fid, feedback = '';
  for (let rev = 0; rev <= (ic.maxRevisions ?? 2); rev++) {
    idea = await chatJson('strategist', persona('strategist') + '\n\n' + RULES(),
      `Existing ideas (do not duplicate): ${existing.join(', ') || 'none'}.\n${hint ? 'Human hint: ' + hint : 'Choose the best brief.'}\n\nNEEDS BRIEFS:\n${JSON.stringify(numbered, null, 1)}${feedback}`);
    const brief = numbered[Number(idea.source_brief)] ?? numbered[0];
    idea.source_brief = brief.id;
    idea.evidence = brief.sources;
    fid = await chatJson('fidelity', persona('fidelity') + '\n\n' + RULES(),
      JSON.stringify({ brief, idea: { title: idea.title, solution_form: idea.solution_form, problem: idea.problem, audience: idea.audience, differentiator: idea.differentiator, quotes_addressed: idea.quotes_addressed, mvp_scope: idea.mvp_scope, phase2: idea.phase2, phase3: idea.phase3, monetization: idea.monetization } }));
    log('ideate', { msg: `fidelity ${fid.score}/10 faithful=${fid.faithful} (revision ${rev})` });
    if (fid.faithful && Number(fid.score) >= (ic.minFidelity ?? 7)) break;
    feedback = `\n\nThe fidelity reviewer REJECTED your last proposal ("${idea.title}"). Gaps: ${(fid.gaps || []).join('; ')}. Missed pains: ${(fid.missed_pains || []).join('; ')}. Fix: ${fid.fix}. Revise it, or pick a different brief.`;
  }
  idea.name = slugify(idea.name || idea.title);
  idea.source_brief_detail = numbered[idea.source_brief];
  idea.fidelity = fid;
  const passed = fid.faithful && Number(fid.score) >= (ic.minFidelity ?? 7);
  const hit = denylistHit(JSON.stringify(idea));
  let verdict = { approved: !hit, violations: hit ? [`denylist match: ${hit}`] : [], needs_human: [] };
  if (!passed) verdict = { approved: false, violations: [`failed fidelity review (${fid.score}/10): ${(fid.gaps || []).join('; ')}`], needs_human: [] };
  else if (!hit) verdict = await chatJson('compliance', persona('compliance') + '\n\n' + RULES(), JSON.stringify({ ...idea, source_brief_detail: undefined }));
  idea.compliance = verdict;
  idea.status = verdict.approved ? 'approved' : 'rejected';
  fs.writeFileSync(path.join(paths.ideas, idea.name + '.json'), JSON.stringify(idea, null, 2));
  log('ideate', { slug: idea.name, msg: `${idea.name}: ${idea.status} ${verdict.violations?.join('; ') ?? ''}` });
  if (verdict.needs_human?.length) requestHuman('needs-human', idea.name, verdict.needs_human);
  return idea.status === 'approved' ? idea.name : null;
}

// ---------- 2. PLAN (OpenSpec + backlog.md) ----------
function architectureMarkdown(a) {
  const alternatives = (a.alternatives || []).map((x) => `### ${x.option}\nPros: ${(x.pros || []).join('; ')}\nCons: ${(x.cons || []).join('; ')}\nWhy not selected: ${x.why_not_selected || 'Not selected'}\n`).join('\n');
  const cost = a.cost || {};
  return `# Production architecture proposal\n\n**Status: proposal only. No account, resource, deployment, or paid service has been activated.**\n\n` +
    `## Decision\nProvider: ${a.provider}\nDeployment model: ${a.deployment_model}\n\n${a.decision}\n\n` +
    `## Framework and language\n${JSON.stringify(a.tech_stack, null, 2)}\n\n## Production components\n${Object.entries(a.components || {}).map(([k, v]) => `- ${k}: ${v}`).join('\n')}\n\n` +
    `## Request and data flow\n${(a.request_and_data_flow || []).map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\n` +
    `## Alternatives considered\n${alternatives || 'No alternatives supplied.'}\n## Assumptions\n${(a.assumptions || []).map((x) => `- ${x}`).join('\n')}\n\n` +
    `## Security and reliability\n${(a.security_and_reliability || []).map((x) => `- ${x}`).join('\n')}\n\n` +
    `## Cost\nEstimate status: ${cost.estimate_status || 'not_assessed'}\nMonthly USD: ${cost.monthly_usd_min ?? 'not estimated'} - ${cost.monthly_usd_max ?? 'not estimated'}\n` +
    `Assumptions: ${(cost.assumptions || []).join('; ') || 'none supplied'}\nOfficial sources: ${(cost.official_sources || []).join(', ') || 'none supplied'}\n\n` +
    `## Human approval required before spending\n${(a.human_approval_required || []).map((x) => `- ${x}`).join('\n') || '- Any paid resource, deployment, account, or external service.'}\n`;
}

async function designArchitecture(slug, idea) {
  const prompt = `Design a production architecture BEFORE selecting implementation frameworks. Product idea:\n${JSON.stringify(idea, null, 2)}\n\n` +
    `Select cloud provider and concrete managed services (or local-only/self-hosted if justified). Compare alternatives; state runtime, API ingress, database, object storage, identity/secrets, networking, observability, IaC and checks-only CI. ` +
    `For AWS REST APIs, explicitly assess Lambda+API Gateway vs ECS/Fargate vs Elastic Beanstalk and RDS vs DynamoDB as relevant. ` +
    `Do not invent cost figures; numeric estimates need official public pricing sources and explicit workload assumptions. This is a proposal only: no accounts, paid APIs, provisioning, deploy, or spend.`;
  const architecture = await chatJson('architect', persona('architect') + '\n\n' + RULES(), prompt);
  if (!architecture || typeof architecture !== 'object' || Array.isArray(architecture)) throw new Error('architect returned an invalid architecture object');
  const problems = [];
  if (!['AWS', 'Azure', 'GCP', 'self-hosted', 'local-only'].includes(architecture.provider)) problems.push('choose a supported provider');
  if (!architecture.decision || typeof architecture.decision !== 'string') problems.push('missing architecture decision and rationale');
  if (typeof architecture.deployment_model !== 'string' || !architecture.deployment_model.trim()) problems.push('missing deployment model');
  const stack = architecture.tech_stack || {};
  if (typeof stack.frontend !== 'string' || !/^(none|react(?:\s|$)|angular(?:\s|$))/i.test(stack.frontend)) problems.push('tech_stack.frontend must choose React, Angular, or none');
  if (typeof stack.backend !== 'string' || !/^(none|node(?:\.js)?\b.*\b(express|fastify|nestjs)\b|\.net\b.*asp\.net core)/i.test(stack.backend)) problems.push('tech_stack.backend must choose Node.js with Express/Fastify/NestJS, ASP.NET Core, or none');
  if (typeof stack.iac !== 'string' || !/^(none|terraform|opentofu)$/i.test(stack.iac)) problems.push('tech_stack.iac must choose Terraform, OpenTofu, or none');
  if (!architecture.components || typeof architecture.components !== 'object') problems.push('missing production components');
  else for (const field of ['compute', 'api_gateway', 'database', 'object_storage', 'cache_queue', 'identity_secrets', 'networking', 'observability', 'ci_cd']) {
    if (typeof architecture.components[field] !== 'string' || !architecture.components[field].trim()) problems.push(`missing architecture component: ${field}`);
  }
  if (!Array.isArray(architecture.request_and_data_flow) || !architecture.request_and_data_flow.length) problems.push('missing concrete request and data flow');
  if (!Array.isArray(architecture.alternatives) || !architecture.alternatives.length) problems.push('compare at least one viable alternative');
  if (!Array.isArray(architecture.assumptions) || !architecture.assumptions.length) problems.push('record workload and operational assumptions');
  if (!Array.isArray(architecture.security_and_reliability) || !architecture.security_and_reliability.length) problems.push('record security and reliability controls');
  if (!Array.isArray(architecture.human_approval_required) || !architecture.human_approval_required.length) problems.push('list human approvals needed before activation');
  if (!architecture.cost || typeof architecture.cost !== 'object' || Array.isArray(architecture.cost)) {
    problems.push('cost must be an object');
    architecture.cost = {};
  }
  architecture.cost.assumptions = Array.isArray(architecture.cost.assumptions) ? architecture.cost.assumptions : [];
  architecture.cost.official_sources = Array.isArray(architecture.cost.official_sources) ? architecture.cost.official_sources : [];
  if (!['not_assessed', 'sourced_estimate'].includes(architecture.cost?.estimate_status)) problems.push('set a valid cost estimate status');
  if (architecture.cost?.estimate_status === 'sourced_estimate') {
    const { monthly_usd_min: min, monthly_usd_max: max } = architecture.cost;
    const validRange = Number.isFinite(min) && Number.isFinite(max) && min >= 0 && max >= min;
    const officialHosts = {
      AWS: ['aws.amazon.com', 'calculator.aws'],
      Azure: ['azure.microsoft.com', 'learn.microsoft.com'],
      GCP: ['cloud.google.com'],
    }[architecture.provider] || [];
    const officialSources = architecture.cost.official_sources.length > 0 && architecture.cost.official_sources.every((source) => {
      try {
        const url = new URL(source);
        return url.protocol === 'https:' && officialHosts.some((host) => url.hostname === host || url.hostname.endsWith('.' + host));
      } catch { return false; }
    });
    if (!validRange || !Array.isArray(architecture.cost.official_sources) || !architecture.cost.official_sources.length ||
      !officialSources || !Array.isArray(architecture.cost.assumptions) || !architecture.cost.assumptions.length) {
      architecture.cost.monthly_usd_min = null;
      architecture.cost.monthly_usd_max = null;
      architecture.cost.estimate_status = 'not_assessed';
      architecture.cost.assumptions = [...architecture.cost.assumptions, 'Unverified price figures removed; obtain human-reviewed estimate from official pricing sources.'];
    }
  } else {
    architecture.cost ||= {};
    architecture.cost.monthly_usd_min = null;
    architecture.cost.monthly_usd_max = null;
  }
  if (problems.length) throw new Error(`incomplete production architecture: ${problems.join('; ')}`);
  const verdict = await chatJson('compliance', persona('compliance') + '\n\n' + RULES(),
    JSON.stringify({ product: idea.title, golden_rules: rulesText(), production_architecture: architecture, instruction: 'Review for compliance only; this proposal does not authorize spend or deployment.' }));
  if (!verdict.approved) {
    requestHuman('architecture-compliance', slug, [`Proposed architecture rejected: ${(verdict.violations || []).join('; ')}`, 'See the generated architecture object in ideas/' + slug + '.json after approval or request a revised plan.']);
    throw new Error(`production architecture failed compliance: ${(verdict.violations || []).join('; ')}`);
  }
  architecture.compliance = verdict;
  idea.production_architecture = architecture;
  idea.tech_stack = architecture.tech_stack;
  idea.architecture_status = 'proposed-human-approval-required-before-any-spend';
  fs.writeFileSync(path.join(paths.ideas, slug + '.json'), JSON.stringify(idea, null, 2));
  requestHuman('production-architecture', slug, [
    `Production proposal: ${architecture.provider} / ${architecture.deployment_model}`,
    architecture.decision,
    `Components: ${JSON.stringify(architecture.components)}`,
    `Cost estimate: ${architecture.cost?.estimate_status || 'not_assessed'}; monthly USD ${architecture.cost?.monthly_usd_min ?? 'not estimated'} - ${architecture.cost?.monthly_usd_max ?? 'not estimated'}.`,
    `Official pricing sources: ${(architecture.cost?.official_sources || []).join(', ') || 'none; request an estimate before use'}`,
    `Approval required before spend: ${(architecture.human_approval_required || []).join('; ') || 'any paid service or deployment'}`,
    'This approval request records the proposal only. It does not authorize provisioning or deployment.',
  ]);
  return architecture;
}

async function plan(slug) {
  haltCheck();
  const ideaFile = path.join(paths.ideas, slug + '.json');
  const idea = JSON.parse(read(ideaFile));
  if (idea.status !== 'approved') throw new Error('idea not approved');
  const architecture = await designArchitecture(slug, idea);
  idea.production_architecture = architecture;
  idea.tech_stack = architecture.tech_stack;
  const pl = await chatJson('pm', persona('pm') + '\n\n' + RULES(), JSON.stringify(idea));
  if (!Array.isArray(pl.tasks) || !pl.tasks.length || !Array.isArray(pl.requirements)) throw new Error('bad plan shape');
  pl.production_architecture = architecture;
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
  if (pl.production_architecture) fs.writeFileSync(path.join(dir, 'production-architecture.md'), architectureMarkdown(pl.production_architecture));
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
function snapshot(dir, focus = '') {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === 'package-lock.json') continue;
    const f = path.join(d, e.name);
    e.isDirectory() ? walk(f) : out.push({ rel: path.relative(dir, f).replace(/\\/g, '/'), f });
  } };
  if (exists(dir)) walk(dir);
  return prioritize(out, focus).map(({ rel, f }) => `FILE: ${rel}\n\`\`\`\n${read(f).slice(0, 6000)}\n\`\`\``).join('\n').slice(0, 24000);
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
const setStatus = (t, s) => backlog(['task', 'edit', num(t), '-s', s]);

// Escalation ladder: small model first, then the large (slow) model. Each retry iterates on the previous work
// with the latest failure plus a memory of earlier ones; a retry that makes things worse is reverted to the
// best state seen, and a stalled task restarts once from a clean base with the lessons learned.
async function buildTask(slug, dir, task) {
  const idea = JSON.parse(read(path.join(paths.ideas, slug + '.json')));
  let feedback = '', note = '';
  const history = [];
  let best = null, stale = 0, restarts = 0;
  const ladder = [...Array(cfg.build.attemptsSmall).fill('engineer'), ...Array(cfg.build.attemptsLarge).fill('engineerLarge')];
  const fail = (attempt, role, text) => { feedback = text; history.push(`attempt ${attempt} (${role}): ${text}`); };
  for (let attempt = 1; attempt <= ladder.length; attempt++) {
    haltCheck();
    const role = ladder[attempt - 1];
    const prompt = `Product: ${idea.title}\n${idea.problem}\nSelected tech stack: ${JSON.stringify(idea.tech_stack || {})}\nProduction architecture proposal (do not provision or deploy): ${JSON.stringify(idea.production_architecture || {})}\n${idea.human_constraints?.length ? 'HUMAN CONSTRAINTS (mandatory, override anything else):\n- ' + idea.human_constraints.join('\n- ') + '\n' : ''}\nTASK ${task.id}: ${task.title}\n${task.body}\n\nCurrent project files (they include your previous attempt; change only what is needed to fix the failures, and output each changed file in full):\n${snapshot(dir, feedback + task.body) || '(empty)'}\n${lessons(history.slice(0, -1))}${note}${feedback}`;
    note = '';
    const reply = await chat(role, persona('engineer') + '\n\n' + RULES(), prompt, { temperature: 0.2 + attempt * 0.1 });
    const files = parseFiles(reply);
    if (!files.length) { fail(attempt, role, '\nYour last reply had no parsable FILE blocks. Follow the output format exactly.'); continue; }
    const dep = await ensureDeps(dir, slug, parseDependencies(reply));
    const depNote = dep.rejected.length ? '\nPackages rejected by the factory (choose a different standard package or built-in): ' + dep.rejected.map((r) => `${r.name} (${r.reason})`).join('; ') + '\n' : '';
    const problems = applyFiles(dir, files);
    if (depNote) problems.push(depNote);
    if (problems.length) { fail(attempt, role, '\nRejected by guard, fix these:\n' + problems.join('\n')); log('guard', { slug, msg: problems.join(' | ') }); continue; }
    if (files.some((f) => /\.(?:mjs|cjs|js|jsx|ts|tsx)$/.test(f.rel)) || dep.added.length) {
      try { ensureNodeProject(dir, slug); } catch (e) { fail(attempt, role, `\nCould not create the locked npm project manifest: ${e.message}`); continue; }
    }
    const profile = detectProfile(dir, idea.tech_stack);
    if (profile.supported) { ensureCiWorkflow(dir, profile); ensureEditorConfig(dir); ensureDependabot(dir, profile); }
    const quality = await runQualityGates(dir, { stage: 'task', stackHint: idea.tech_stack });
    const failedChecks = quality.checks.filter((c) => c.status === 'failed');
    if (!quality.ok) {
      const score = failScore(failedChecks);
      fail(attempt, role, `\nQuality gates FAILED (attempt ${attempt}, ${score} failing). Fix all required failures:\n` + failedChecks.map((c) => `${c.name}: ${c.detail}`).join('\n'));
      log('quality-fail', { slug, msg: `${task.id}: ${failedChecks.map((c) => c.name).join(', ')} (${score} failing)` });
      if (!best || score < best.score) { best = { score, commit: checkpoint(dir) }; stale = 0; }
      else {
        stale++;
        if (score > best.score && best.commit) { restore(dir, best.commit); note = `\nYour last attempt had ${score} failures versus ${best.score} before it, so it was reverted to the best earlier state shown above. Take a different approach to the remaining failures.\n`; log('build-revert', { slug, msg: `${task.id}: ${score} > ${best.score}, reverted to best` }); }
      }
      if (stale >= (cfg.build.restartAfterStale ?? 2) && restarts < (cfg.build.maxRestarts ?? 1) && attempt < ladder.length) {
        rollback(dir); best = null; stale = 0; restarts++;
        note = '\nProgress has stalled, so the working files were reset to the last committed state. Start over with a different design, applying the lessons below.\n';
        log('build-restart', { slug, msg: `${task.id}: stalled, restarting from clean base` });
      }
      continue;
    }
    const t = { ok: true, out: quality.checks.map((c) => `${c.status.toUpperCase()} ${c.name}: ${c.detail}`).join('\n') };
    const review = await chatJson('reviewer', persona('reviewer') + '\n\n' + RULES(),
      `Task: ${task.title}\n${task.body}\n\nSelected tech stack: ${JSON.stringify(idea.tech_stack || {})}\nProduction architecture: ${JSON.stringify(idea.production_architecture || {})}\nDetected stack: ${quality.profile.stacks.join(', ')}\nQuality-check evidence (never treat SKIPPED as passing):\n${t.out}\n\nFiles:\n${snapshot(dir)}`);
    if (review.verdict !== 'pass') { fail(attempt, role, '\nReviewer rejected:\n- ' + (review.issues || []).join('\n- ')); log('review-fail', { slug, msg: feedback.slice(0, 200) }); continue; }
    return { ok: true, summary: review.summary };
  }
  return { ok: false, failure: feedback.slice(0, 3000) };
}

const commit = (dir, msg) => { git(dir, 'add', '-A'); git(dir, '-c', 'user.name=factory', '-c', 'user.email=factory@local', 'commit', '-qm', msg); };
const hasHead = (dir) => git(dir, 'rev-parse', '--verify', '-q', 'HEAD').status === 0;
const rollback = (dir) => { if (hasHead(dir)) git(dir, 'reset', '-q', '--hard'); else git(dir, 'rm', '-rf', '--cached', '-q', '.'); git(dir, 'clean', '-fdq'); };
// A checkpoint is a dangling commit of the working tree; restore() returns the tree to exactly that state.
function checkpoint(dir) {
  git(dir, 'add', '-A');
  const tree = git(dir, 'write-tree').stdout.trim();
  const args = ['-c', 'user.name=factory', '-c', 'user.email=factory@local', 'commit-tree', tree, '-m', 'factory-checkpoint'];
  if (hasHead(dir)) args.push('-p', git(dir, 'rev-parse', 'HEAD').stdout.trim());
  return git(dir, ...args).stdout.trim() || null;
}
function restore(dir, commitId) { rollback(dir); if (commitId) git(dir, 'checkout', commitId, '--', '.'); }
const num = (t) => t.id.replace(/^\D+/, '');
const depthOf = (t) => Math.max(0, ...t.labels.map((l) => (l.match(/^depth-(\d+)$/) || [, 0])[1]).map(Number));
const openChildren = (slug, task) => listTasks(slug).filter((t) => t.parent === task.id && t.status !== 'Done');

// Ask the large model to rescope a failing task into smaller, independently testable subtasks.
async function split(slug, dir, task, failure) {
  const depth = depthOf(task) + 1;
  const existing = openChildren(slug, task);
  if (existing.length) { log('task-split', { slug, msg: `${task.id} reusing existing subtasks ${existing.map((t) => t.id).join(', ')}` }); return existing; }
  const idea = JSON.parse(read(path.join(paths.ideas, slug + '.json')));
  const out = await chatJson('planner', persona('splitter') + '\n\n' + RULES(),
    `PRODUCT TECH STACK: ${JSON.stringify(idea.tech_stack || {})}\nPRODUCTION ARCHITECTURE: ${JSON.stringify(idea.production_architecture || {})}\nTASK ${task.id}: ${task.title}\n${task.body}\n\nWhy it failed:\n${failure}\n\nCurrent project files:\n${snapshot(dir) || '(empty)'}`);
  const subs = (out.subtasks || []).slice(0, 4);
  if (subs.length < 2) return [];
  const before = new Set(listTasks(slug).map((t) => t.id));
  for (const [i, s] of subs.entries()) {
    const args = ['task', 'create', `${task.title} (${i + 1}/${subs.length}): ${s.title}`, '-d', `${s.description}\n\nFiles: ${(s.files || []).join(', ')}\nSplit from ${task.id}; ${out.note || ''}`,
      '-l', `${slug},depth-${depth}`, '-p', num(task), '--plain'];
    for (const a of s.acceptance || []) args.push('--ac', a);
    backlog(args);
  }
  const fresh = listTasks(slug).filter((t) => !before.has(t.id) && t.parent === task.id);
  log('task-split', { slug, msg: `${task.id} -> ${fresh.map((t) => t.id).join(', ')}` });
  return fresh;
}

// Returns true when the task (or all its subtasks) is complete.
async function runTask(slug, dir, task) {
  haltCheck();
  setStatus(task, 'In Progress');
  // A task already split into subtasks resumes them instead of retrying the whole task.
  const resumed = openChildren(slug, task);
  const r = resumed.length ? { ok: false, failure: 'resuming previously created subtasks' } : await buildTask(slug, dir, task);
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
  const profile = detectProfile(dir, idea.tech_stack);
  if (profile.supported) { ensureCiWorkflow(dir, profile); ensureEditorConfig(dir); ensureDependabot(dir, profile); }
  const quality = await runQualityGates(dir, { stage: 'release', stackHint: idea.tech_stack });
  const failures = quality.checks.filter((c) => c.status === 'failed');
  if (!quality.ok) {
    log('release-blocked', { slug, msg: failures.map((c) => `${c.name}: ${c.detail}`).join(' | ') });
    requestHuman('quality-gates', slug, [
      'Release is blocked because required local quality gates failed or are unavailable.',
      ...failures.map((c) => `FAIL ${c.name}: ${c.detail}`),
      ...quality.checks.filter((c) => c.status === 'skipped').map((c) => `SKIPPED ${c.name}: ${c.detail}`),
      'Install/configure required tools or fix failures, then retry: node factory/cli.mjs release ' + slug,
    ]);
    return false;
  }
  git(dir, 'add', '.github/workflows/ci.yml', '.github/dependabot.yml', '.editorconfig');
  git(dir, '-c', 'user.name=factory', '-c', 'user.email=factory@local', 'commit', '-qm', 'ci: enforce local quality gates');
  const out = await chatJson('pm', persona('release') + '\n\n' + RULES(), `${JSON.stringify(idea)}\n\nFiles:\n${snapshot(dir)}`);
  const verdict = denylistHit(JSON.stringify(out));
  if (verdict) { log('release-blocked', { slug, msg: 'denylist ' + verdict }); return; }
  fs.writeFileSync(path.join(dir, 'README.md'), out.readme);
  git(dir, 'add', '-A'); git(dir, '-c', 'user.name=factory', '-c', 'user.email=factory@local', 'commit', '-qm', 'docs: README');
  requestHuman('publish', slug, [
    `Listing copy: ${out.listing}`,
    `Pricing suggestion: ${out.pricing_suggestion}`,
    `Production architecture proposal: ${JSON.stringify(idea.production_architecture || {})}`,
    'Architecture document: openspec/changes/' + slug + '/production-architecture.md',
    'No cloud resources, deployment, paid APIs or publishing have been activated. Explicit written human approval is required before any spend or deployment.',
    ...(out.human_steps || []).map((s) => 'HUMAN STEP: ' + s),
    `Product dir: products/${slug}`,
  ]);
  const idf = path.join(paths.ideas, slug + '.json'); const idea2 = JSON.parse(read(idf)); idea2.status = 'ready-for-human'; fs.writeFileSync(idf, JSON.stringify(idea2, null, 2));
  return true;
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
  const profile = detectProfile(dir, idea.tech_stack);
  const quality = await runQualityGates(dir, { stage: 'release', stackHint: idea.tech_stack });
  const hasNodeEntry = exists(path.join(dir, 'src', 'main.mjs'));
  const mech = hasNodeEntry
    ? await mechanicalEval(dir)
    : { tests: { ok: quality.ok, out: quality.checks.map((c) => `${c.status.toUpperCase()} ${c.name}: ${c.detail}`).join('\n') },
      smoke: { checks: [{ name: 'stack-specific smoke/e2e', ok: quality.checks.some((c) => c.name === 'playwright-e2e' && c.status === 'passed'), detail: 'See structured quality results; Node-only HTTP smoke is not applicable.' }], stderr: '' },
      stats: { stack: profile.stacks } };
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
    `\nPRODUCTION ARCHITECTURE DECISION:\n${JSON.stringify(idea.production_architecture || {}, null, 1)}\n\nEARLIER ITERATIONS:\n${history}\n\nOPEN/BLOCKED TASKS:\n${open}\n\nMECHANICAL RESULTS\nDetected stack: ${profile.stacks.join(', ') || 'UNSUPPORTED'}\nTests ${mech.tests.ok ? 'PASSED' : 'FAILED'}:\n${mech.tests.out.slice(-1500)}\nSmoke test:\n${smoke}\nServer stderr: ${mech.smoke.stderr || '(none)'}\nStats: ${JSON.stringify(mech.stats)}\nQuality checks (SKIPPED is not PASS):\n${quality.checks.map((c) => `${c.status.toUpperCase()} ${c.name} [required=${c.required}]: ${c.detail}`).join('\n')}\n\nFILE TREE:\n${tree(dir)}\n\nSOURCE:\n${snapshot(dir)}`;
  const ev = await chatJson('evaluator', persona('evaluator') + '\n\n' + RULES(), prompt);
  ev.quality_score = Number(ev.quality_score) || 0;
  ev.mechanical = { tests_ok: mech.tests.ok, smoke: mech.smoke.checks, stats: mech.stats, quality: quality.checks };
  log('evaluate', { slug, msg: `iteration ${n}: score ${ev.quality_score}/10, tests ${mech.tests.ok ? 'pass' : 'FAIL'}, smoke ${mech.smoke.checks.filter((c) => !c.ok).length} failing` });
  return ev;
}

async function planIteration(slug, n, ev, feedback) {
  const idea = loadIdea(slug);
  const max = cfg.iterate.maxTasksPerIteration;
  const prompt = `Plan iteration ${n}. Maximum tasks: ${max}. Task titles must start with "I${n}: ".\n\nPRODUCT: ${idea.title}\nProblem: ${idea.problem}\nPRODUCTION ARCHITECTURE (preserve unless evaluation proves a concrete issue): ${JSON.stringify(idea.production_architecture || {})}\nphase2: ${JSON.stringify(idea.phase2)}\nphase3: ${JSON.stringify(idea.phase3)}\n` +
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

async function modelsStatus(testRole) {
  const state = path.join(ROOT, 'factory', 'state');
  const usage = readUsage(state).tokens;
  for (const [role, v] of Object.entries(cfg.models)) {
    const chain = specsFor(v).map((s) => {
      const { provider, conf } = parseSpec(s, cfg.providers);
      const why = provider === 'ollama' ? null : blockedReason(provider, conf, state);
      return `${s}${why ? `  [SKIPPED: ${why}]` : provider === 'ollama' ? '' : '  [ready]'}`;
    });
    console.log(`${role.padEnd(14)} ${chain.join('  ->  ')}`);
  }
  for (const [n, c] of Object.entries(cfg.providers || {})) console.log(`provider ${n}: ${c.enabled ? 'ENABLED' : 'disabled'}, tokens today ${usage[n] || 0}/${c.dailyTokenCap}`);
  if (testRole) { const r = await chat(testRole, 'Reply with the single word: ok', 'ping', { temperature: 0 }); console.log(`test ${testRole}: ${JSON.stringify(r.slice(0, 80))}`); }
}

// Clears the locked label on a product's tasks so the next build resumes them (and any subtasks already created).
function unblock(slug) {
  if (!slug) throw new Error('usage: unblock <slug>');
  const blocked = listTasks(slug).filter((t) => t.labels.includes('blocked'));
  for (const t of blocked) backlog(['task', 'edit', num(t), '--remove-label', 'blocked']);
  console.log(blocked.length ? `Unblocked: ${blocked.map((t) => t.id).join(', ')}\nNow run: node factory/cli.mjs build ${slug}` : 'No blocked tasks for ' + slug);
}

const [cmd, arg, ...rest] = process.argv.slice(2);
const cmds = {
  research: () => research(true).then((r) => r.opportunities.forEach((o) => console.log(`- [${o.demand_strength}, score ${o.total ?? "?"}, ${(o.lenses || []).join("+") || "general"}] ${o.saas_concept}\n    ${o.evidence.join(' ')}`))),
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
  models: () => modelsStatus(arg === 'test' ? rest[0] || 'reviewer' : null),
  unblock: () => unblock(arg),
  halt: () => fs.writeFileSync(path.join(ROOT, 'HALT'), 'stop'),
  resume: () => fs.rmSync(path.join(ROOT, 'HALT'), { force: true }),
};
if (!cmds[cmd]) { console.log('usage: node factory/cli.mjs <research|ideate [hint]|plan <slug>|build <slug>|release <slug>|cycle [hint]|loop|status|approve|reject|scrap <slug> [--yes]|iterate <slug> [--count N|--plan-only|--auto [--max N]]|iterate-approve <slug>|iterate-reject <slug>|iterate-stop <slug|all> [--now]|unblock <slug>|models [test <role>]|scout|tools|tools-approve <id> [--url U --roles r1,r2]|tools-reject <id>|halt|resume>'); process.exit(1); }
Promise.resolve(cmds[cmd]()).catch((e) => { log('fatal', { msg: e.stack }); process.exit(1); });
