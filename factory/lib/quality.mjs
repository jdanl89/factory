import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const IGNORED = new Set(['.git', 'node_modules', '.terraform', 'bin', 'obj', 'dist', 'coverage']);
const walk = (dir, rel = '') => {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory() && IGNORED.has(e.name)) continue;
    if (e.isDirectory()) out.push(...walk(dir, r)); else out.push(r);
  }
  return out;
};
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };

export function detectProfile(dir, stackHint = {}) {
  const files = fs.existsSync(dir) ? walk(dir).map((x) => x.replace(/\\/g, '/')) : [];
  const pkg = readJson(path.join(dir, 'package.json'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const hasCsproj = files.some((f) => f.endsWith('.csproj') || f.endsWith('.sln') || f.endsWith('.slnx'));
  const hasTerraform = files.some((f) => f.endsWith('.tf') || f.endsWith('.tf.json'));
  const lock = files.find((f) => f.endsWith('.terraform.lock.hcl'));
  const iacTool = lock
    ? (fs.readFileSync(path.join(dir, lock), 'utf8').includes('registry.opentofu.org') ? 'opentofu' : 'terraform')
    : (/opentofu/i.test(stackHint.iac || '') ? 'opentofu' : 'terraform');
  const frontend = deps['@angular/core'] ? 'angular' : deps.react || deps['react-dom'] ? 'react' : null;
  const backend = hasCsproj ? 'dotnet' : deps.express || deps.fastify || deps.koa || deps['@nestjs/core'] ? 'node' : null;
  const hasNode = !!pkg.name || files.some((f) => /\.(mjs|cjs|js|tsx|ts)$/.test(f));
  const hasUi = !!frontend || files.includes('public/index.html') || files.includes('index.html');
  const stacks = [];
  if (hasNode || frontend) stacks.push('node');
  if (frontend) stacks.push(frontend);
  if (backend) stacks.push(backend);
  if (hasTerraform) stacks.push(iacTool);
  return { supported: stacks.length > 0, stacks, frontend, backend, hasUi, iac: hasTerraform ? iacTool : null, package: pkg, files };
}

function command(binary, args, cwd, timeout = 300000) {
  const r = spawnSync(binary, args, { cwd, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error?.message || '' };
}

const hasScript = (p, name) => typeof p.scripts?.[name] === 'string' && !!p.scripts[name].trim();

export function secretFindings(dir) {
  const patterns = [
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
    ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
    ['cloud access token', /\b(?:xox[baprs]-|sk_live_)[A-Za-z0-9_-]{16,}\b/],
  ];
  const findings = [];
  for (const rel of walk(dir)) {
    if (/\.(?:png|jpe?g|gif|ico|woff2?|ttf|map|lock|db|sqlite|zip)$/i.test(rel)) continue;
    let text;
    try { text = fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { continue; }
    for (const [name, re] of patterns) if (re.test(text)) findings.push(`${rel}: possible ${name}`);
  }
  return findings;
}

function result(checks, name, status, detail, required = false) {
  checks.push({ name, status, detail: String(detail || '').slice(-1200), required });
}
function run(checks, name, runner, binary, args, cwd, required = false) {
  const r = runner(binary, args, cwd);
  if (r.error && /not found|not recognized|ENOENT/i.test(r.error)) result(checks, name, required ? 'failed' : 'skipped', `${binary} unavailable: ${r.error}`, required);
  else if (r.status === 0) result(checks, name, 'passed', r.stdout + r.stderr, required);
  else result(checks, name, 'failed', r.error || r.stdout + r.stderr || `exit ${r.status}`, required);
  return checks[checks.length - 1];
}

function addScript(checks, pkg, runner, name, dir, required = false, suggestion = '') {
  if (!hasScript(pkg, name)) { result(checks, name, required ? 'failed' : 'skipped', suggestion || `script "${name}" is not configured`, required); return; }
  run(checks, name, runner, 'npm', ['run', name], dir, required);
}

function ciWorkflow(profile) {
  const semgrepConfigs = [
    ...(profile.stacks.includes('node') ? ['--config p/javascript', '--config p/typescript'] : []),
    ...(profile.backend === 'dotnet' ? ['--config p/csharp'] : []),
    '--config p/secrets',
  ].join(' ');
  const lines = [
    'name: Quality gates', '', 'on:', '  push:', '  pull_request:', '',
    'permissions:', '  contents: read', '', 'concurrency:', '  group: quality-${{ github.workflow }}-${{ github.ref }}',
    '  cancel-in-progress: true', '', 'jobs:', '  checks:',
    '    runs-on: ubuntu-latest', '    steps:', '      - uses: actions/checkout@v4',
  ];
  if (profile.backend === 'dotnet') {
    lines.push('      - uses: actions/setup-dotnet@v4', '        with:', '          dotnet-version: 10.0.x',
      '      - name: Restore locked dependencies', '        run: dotnet restore --locked-mode -warnaserror:NU1903,NU1904',
      '      - name: Test', '        run: dotnet test --configuration Release --no-restore',
      '      - name: Check vulnerable dependencies', '        run: dotnet list package --vulnerable --include-transitive',
      '      - name: Verify formatting', '        run: dotnet format --verify-no-changes --no-restore');
  }
  lines.push('      - name: Install Semgrep', '        run: pipx install semgrep',
    '      - name: Static analysis and secret scan', `        run: semgrep scan ${semgrepConfigs} --error .`);
  if (profile.stacks.includes('node')) {
    lines.push('      - uses: actions/setup-node@v4', '        with:', '          node-version: 22', '          cache: npm',
      '      - name: Install locked dependencies', '        run: npm ci --ignore-scripts',
      '      - name: Run tests', '        run: npm test',
      '      - name: Audit dependencies', '        run: npm audit --audit-level=high',
      '      - name: Lint', '        run: npm run lint',
      '      - name: Check formatting', '        run: npm run format:check',
      ...(profile.files.some((f) => /\.(ts|tsx)$/.test(f)) ? ['      - name: Type check', '        run: npm run typecheck'] : []),
      ...(profile.frontend ? ['      - name: Build frontend', '        run: npm run build'] : []),
      '      - name: Unit tests', '        run: npm run test:unit',
      ...(profile.hasUi ? ['      - name: Install Playwright browser', '        run: npx playwright install --with-deps chromium'] : []),
      ...(profile.backend === 'node' ? ['      - name: Run integration tests', '        run: npm run test:integration'] : []),
      ...(profile.hasUi ? ['      - name: Run Playwright end-to-end tests', '        run: npm run test:e2e'] : []));
  }
  if (profile.iac) {
    const exe = profile.iac === 'opentofu' ? 'tofu' : 'terraform';
    lines.push(profile.iac === 'opentofu' ? '      - uses: opentofu/setup-opentofu@v1' : '      - uses: hashicorp/setup-terraform@v3',
      '      - name: Check infrastructure formatting', `        run: ${exe} fmt -check -recursive`,
      '      - name: Initialize without backend', `        run: ${exe} init -backend=false -input=false -lockfile=readonly`,
      '      - name: Validate infrastructure', `        run: ${exe} validate`,
      '      - name: Scan infrastructure security', '        uses: aquasecurity/trivy-action@0.28.0',
      '        with:', '          scan-type: config', '          scan-ref: .', '          exit-code: 1');
  }
  lines.push('');
  return lines.join('\n');
}

export function ensureCiWorkflow(dir, profile) {
  if (!profile.supported) return { path: null, created: false, reason: 'unsupported project stack' };
  const f = path.join(dir, '.github', 'workflows', 'ci.yml');
  if (fs.existsSync(f)) return { path: f, created: false, reason: 'existing workflow left unchanged' };
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, ciWorkflow(profile));
  return { path: f, created: true, reason: 'generated checks-only workflow; no deploy, credentials or paid API' };
}

export function ensureDependabot(dir, profile) {
  const f = path.join(dir, '.github', 'dependabot.yml');
  if (fs.existsSync(f)) return { path: f, created: false };
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const lines = ['version: 2', 'updates:',
    '  - package-ecosystem: github-actions', '    directory: /', '    schedule:', '      interval: weekly'];
  if (profile.stacks.includes('node')) lines.push('  - package-ecosystem: npm', '    directory: /', '    schedule:', '      interval: weekly');
  if (profile.backend === 'dotnet') lines.push('  - package-ecosystem: nuget', '    directory: /', '    schedule:', '      interval: weekly');
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return { path: f, created: true };
}

export function ensureEditorConfig(dir) {
  const f = path.join(dir, '.editorconfig');
  if (fs.existsSync(f)) return { path: f, created: false };
  fs.writeFileSync(f, [
    'root = true', '', '[*]', 'charset = utf-8', 'end_of_line = lf', 'insert_final_newline = true',
    'indent_style = space', 'indent_size = 2', 'trim_trailing_whitespace = true', '',
    '[*.cs]', 'indent_size = 4', '', '[*.{md,yml,yaml}]', 'trim_trailing_whitespace = false', '',
  ].join('\n'));
  return { path: f, created: true };
}

export function workflowViolations(dir, profile = null) {
  const f = path.join(dir, '.github', 'workflows', 'ci.yml');
  if (!fs.existsSync(f)) return ['CI workflow missing'];
  const text = fs.readFileSync(f, 'utf8');
  const violations = [];
  if (/\b(terraform|tofu)\s+(?:apply|destroy)\b|\bdotnet\s+publish\b|\bnpm\s+publish\b|\bhelm\s+upgrade\b|\bkubectl\s+apply\b|\b(?:aws|az|gcloud)\s+(?:cloudformation|deployment|deploy|apply)\b|\bpulumi\s+up\b|\b(?:vercel|wrangler|fly)\s+deploy\b/i.test(text)) violations.push('CI workflow contains a deploy/publish command');
  if (/\$\{\{\s*secrets\./i.test(text)) violations.push('CI workflow references GitHub secrets');
  if (/permissions:\s*(?:write-all|read-all)/i.test(text) || /\b(?:contents|actions|id-token|packages|pull-requests|issues):\s*write\b/i.test(text)) violations.push('CI workflow grants write permissions');
  if (!/^on:(?:[ \t]+(?:push|pull_request|workflow_dispatch)\b|[ \t]*\r?\n[ \t]*(?:push|pull_request|workflow_dispatch):)/m.test(text))
    violations.push('CI workflow has no push, pull_request or manual trigger');
  if (!/permissions:\s*\n\s+contents:\s+read/i.test(text)) violations.push('CI must explicitly set least-privilege contents: read permissions');
  if (!/uses:\s*actions\/checkout@/m.test(text)) violations.push('CI workflow does not checkout source');
  if (profile?.stacks.includes('node')) {
    for (const item of ['npm ci --ignore-scripts', 'npm test', 'npm audit', 'semgrep scan', 'npm run lint', 'npm run format:check', 'npm run test:unit'])
      if (!text.includes(item)) violations.push(`CI workflow is missing required step: ${item}`);
    if (profile.frontend && !text.includes('npm run build')) violations.push('CI workflow is missing frontend build');
    if (profile.hasUi && (!text.includes('npm run test:e2e') || !text.includes('playwright install'))) violations.push('CI workflow is missing Playwright e2e');
    if (profile.backend === 'node' && !text.includes('npm run test:integration')) violations.push('CI workflow is missing backend integration tests');
    if (profile.files.some((f) => /\.(ts|tsx)$/.test(f)) && !text.includes('npm run typecheck')) violations.push('CI workflow is missing TypeScript typecheck');
  }
  if (profile?.backend === 'dotnet') for (const item of ['dotnet restore --locked-mode', 'dotnet test --configuration Release', 'dotnet list package --vulnerable --include-transitive', 'dotnet format --verify-no-changes --no-restore'])
    if (!text.includes(item)) violations.push(`CI workflow is missing required step: ${item}`);
  if (profile?.backend === 'dotnet') {
    if (!text.includes('--config p/csharp')) violations.push('CI workflow is missing C# static analysis');
    if (!walk(dir).some((f) => f.endsWith('packages.lock.json'))) violations.push('CI workflow requires a committed NuGet packages.lock.json');
  }
  if (profile?.iac && (!text.includes(`${profile.iac === 'opentofu' ? 'tofu' : 'terraform'} fmt -check`) || !text.includes('validate') || !text.includes('trivy-action')))
    violations.push('CI workflow is missing IaC format, validation or security scan');
  if (profile?.iac && !walk(dir).some((f) => f.endsWith('.terraform.lock.hcl'))) violations.push('CI workflow requires a committed IaC provider lock file');
  return violations;
}

// Run local, non-deploying quality checks. Optional missing tools are explicit skips; missing required release gates fail.
export async function runQualityGates(dir, { stage = 'task', runner = command, stackHint = {} } = {}) {
  const profile = detectProfile(dir, stackHint), checks = [];
  if (!profile.supported) {
    result(checks, 'supported-stack', 'failed', 'No recognized Node.js, React, Angular, .NET or Terraform/OpenTofu project found', true);
    return { ok: false, profile, checks };
  }
  result(checks, 'supported-stack', 'passed', profile.stacks.join(', '), true);
  const strict = stage === 'release';
  const findings = secretFindings(dir);
  result(checks, 'secret-scan', findings.length ? 'failed' : 'passed', findings.join('\n') || 'No common private-key/token formats detected', true);

  if (profile.stacks.includes('node')) {
    const p = profile.package;
    const ui = profile.hasUi;
    const ts = profile.files.some((f) => /\.(ts|tsx)$/.test(f));
    for (const script of ['lint', 'format:check', ...(ts ? ['typecheck'] : [])]) {
      if (hasScript(p, script)) addScript(checks, p, runner, script, dir);
      else result(checks, script, strict ? 'failed' : 'skipped', `${script} script not configured`, strict);
    }
    if (hasScript(p, 'build')) addScript(checks, p, runner, 'build', dir, strict);
    else result(checks, 'build', strict && !!profile.frontend ? 'failed' : 'skipped', profile.frontend ? 'frontend build script missing' : 'build script not configured', strict && !!profile.frontend);
    const tests = profile.files.filter((f) => /(^|\/)(test|tests)\//.test(f) && /\.(?:test|spec)\.(?:mjs|cjs|js|jsx|ts|tsx)$/.test(f));
    result(checks, 'test-files', tests.length ? 'passed' : 'failed', tests.length ? `${tests.length} test file(s)` : 'No unit/integration/e2e test files found', true);
    addScript(checks, p, runner, 'test', dir, true, 'required test script missing');
    if (hasScript(p, 'test:unit')) addScript(checks, p, runner, 'test:unit', dir);
    else result(checks, 'unit-tests', strict ? 'failed' : 'skipped', 'test:unit script not configured (generic test script ran)', strict);
    if (hasScript(p, 'test:integration')) addScript(checks, p, runner, 'test:integration', dir);
    else result(checks, 'integration-tests', strict && !!profile.backend ? 'failed' : 'skipped', 'test:integration script not configured', strict && !!profile.backend);
    if (ui) {
      const playwright = !!(p.dependencies?.['@playwright/test'] || p.devDependencies?.['@playwright/test']);
      if (!playwright) result(checks, 'playwright-e2e', strict ? 'failed' : 'skipped', '@playwright/test is not declared', strict);
      else addScript(checks, p, runner, 'test:e2e', dir, true, 'Playwright is declared but test:e2e script is missing');
    } else result(checks, 'playwright-e2e', 'skipped', 'no browser UI detected');
    if (strict) run(checks, 'npm-audit', runner, 'npm', ['audit', '--audit-level=high'], dir, true);
    else result(checks, 'npm-audit', 'skipped', 'runs at release gate');
    if (strict) run(checks, 'sast-semgrep-secrets', runner, 'semgrep', ['scan', '--config', 'p/javascript', '--config', 'p/typescript', '--config', 'p/secrets', '--error', dir], dir, true);
    else result(checks, 'sast-semgrep', 'skipped', 'Semgrep static analysis runs at release gate');
    if (strict && !fs.existsSync(path.join(dir, 'package-lock.json'))) result(checks, 'dependency-lockfile', 'failed', 'package-lock.json is required for reproducible npm ci', true);
    else if (strict) result(checks, 'dependency-lockfile', 'passed', 'package-lock.json present', true);
  }

  if (profile.backend === 'dotnet') {
    const testProjects = profile.files.filter((f) => f.endsWith('.csproj') && /(?:test|tests)/i.test(f));
    result(checks, 'dotnet-test-project', testProjects.length ? 'passed' : 'failed', testProjects.length ? testProjects.join(', ') : 'No test project found', true);
    const hasLock = walk(dir).some((f) => f.endsWith('packages.lock.json'));
    if (strict && !hasLock) result(checks, 'nuget-lockfile', 'failed', 'packages.lock.json is required for reproducible NuGet restore', true);
    else if (strict) result(checks, 'nuget-lockfile', 'passed', 'NuGet lock file present', true);
    let restore;
    if (strict && !hasLock) {
      result(checks, 'dotnet-restore-locked', 'failed', 'Requires a committed packages.lock.json', true);
      restore = checks[checks.length - 1];
    } else restore = run(checks, 'dotnet-restore-locked', runner, 'dotnet', ['restore', ...(strict ? ['--locked-mode'] : ['--use-lock-file']), '-warnaserror:NU1903,NU1904'], dir, true);
    if (restore.status === 'passed') {
      run(checks, 'dotnet-format', runner, 'dotnet', ['format', '--verify-no-changes', '--no-restore'], dir, strict);
      run(checks, 'dotnet-test', runner, 'dotnet', ['test', '--configuration', 'Release', '--no-restore'], dir, true);
    } else {
      result(checks, 'dotnet-format', 'failed', 'Requires successful NuGet restore', strict);
      result(checks, 'dotnet-test', 'failed', 'Requires successful NuGet restore', true);
    }
    if (strict) run(checks, 'dotnet-vulnerable-packages', runner, 'dotnet', ['list', 'package', '--vulnerable', '--include-transitive'], dir, true);
    else result(checks, 'dotnet-vulnerable-packages', 'skipped', 'dependency vulnerability scan runs at release gate');
    if (strict) run(checks, 'sast-semgrep-secrets', runner, 'semgrep', ['scan', '--config', 'p/csharp', '--config', 'p/secrets', '--error', dir], dir, true);
  }

  if (profile.iac) {
    const exe = profile.iac === 'opentofu' ? 'tofu' : 'terraform';
    const version = runner(exe, ['version'], dir);
    if (version.error && /not found|not recognized|ENOENT/i.test(version.error)) {
      result(checks, 'iac-tool', 'failed', `${exe} is required for infrastructure projects: ${version.error}`, true);
    } else if (version.status !== 0) {
      result(checks, 'iac-tool', 'failed', version.error || version.stderr || `${exe} version exited ${version.status}`, true);
    } else {
      result(checks, 'iac-tool', 'passed', `${exe} available`, true);
      run(checks, 'iac-format', runner, exe, ['fmt', '-check', '-recursive'], dir, true);
      const hasLock = profile.files.some((f) => f.endsWith('.terraform.lock.hcl'));
      if (strict && !hasLock) result(checks, 'iac-lockfile', 'failed', '.terraform.lock.hcl is required for reproducible provider installation', true);
      else if (strict) result(checks, 'iac-lockfile', 'passed', '.terraform.lock.hcl present', true);
      const initArgs = ['init', '-backend=false', '-input=false', ...(hasLock ? ['-lockfile=readonly'] : [])];
      let init;
      if (strict && !hasLock) {
        result(checks, 'iac-init-no-backend', 'failed', 'Requires a committed .terraform.lock.hcl', true);
        init = checks[checks.length - 1];
      } else init = run(checks, 'iac-init-no-backend', runner, exe, initArgs, dir, true);
      if (init.status === 'passed') run(checks, 'iac-validate', runner, exe, ['validate'], dir, true);
      else result(checks, 'iac-validate', 'failed', 'Requires successful backend-free init', true);
      const trivy = runner('trivy', ['config', '--exit-code', '1', dir], dir);
      if (trivy.error && /not found|not recognized|ENOENT/i.test(trivy.error)) result(checks, 'iac-security-scan', strict ? 'failed' : 'skipped', 'Trivy is not installed', strict);
      else if (trivy.status === 0) result(checks, 'iac-security-scan', 'passed', trivy.stdout + trivy.stderr);
      else result(checks, 'iac-security-scan', 'failed', trivy.error || trivy.stdout + trivy.stderr, strict);
    }
  }

  if (strict) {
    const violations = workflowViolations(dir, profile);
    result(checks, 'ci-workflow-policy', violations.length ? 'failed' : 'passed', violations.join('; ') || 'checks-only workflow verified', true);
  }

  return { ok: checks.every((c) => c.status !== 'failed'), profile, checks };
}
