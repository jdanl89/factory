import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectProfile, ensureCiWorkflow, runQualityGates, secretFindings, workflowViolations } from './quality.mjs';

const fixture = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-quality-'));
  for (const [name, text] of Object.entries(files)) {
    const f = path.join(dir, name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  return dir;
};
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });
const success = () => ({ status: 0, stdout: 'ok', stderr: '', error: '' });

test('detects React, Node, .NET and Terraform project stacks', () => {
  const dir = fixture({
    'package.json': JSON.stringify({ name: 'web', dependencies: { react: '1' }, scripts: { test: 'node --test' } }),
    'src/App.jsx': 'export default function App() {}',
    'backend/App.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web" />',
    'infra/main.tf': 'terraform {}',
  });
  try {
    const p = detectProfile(dir);
    assert.deepEqual(p.stacks, ['node', 'react', 'dotnet', 'terraform']);
    assert.equal(p.frontend, 'react');
    assert.equal(p.backend, 'dotnet');
    assert.equal(p.iac, 'terraform');
    assert.equal(p.hasUi, true);
  } finally { cleanup(dir); }
});

test('detects NestJS and static browser UIs and generates e2e CI steps', () => {
  const dir = fixture({
    'package.json': JSON.stringify({ name: 'service', dependencies: { '@nestjs/core': '1' } }),
    'public/index.html': '<main>app</main>',
  });
  try {
    const p = detectProfile(dir);
    assert.equal(p.backend, 'node');
    assert.equal(p.hasUi, true);
    const { path: workflow } = ensureCiWorkflow(dir, p);
    const text = fs.readFileSync(workflow, 'utf8');
    assert.match(text, /npm run test:e2e/);
    assert.match(text, /playwright install/);
    assert.match(text, /npm run test:integration/);
  } finally { cleanup(dir); }
});

test('detects Angular as a TypeScript browser stack', () => {
  const dir = fixture({
    'package.json': JSON.stringify({ name: 'web', dependencies: { '@angular/core': '1', '@angular/cli': '1' } }),
    'src/app.component.ts': 'export class AppComponent {}',
    'index.html': '<app-root></app-root>',
  });
  try {
    const p = detectProfile(dir);
    assert.equal(p.frontend, 'angular');
    assert.equal(p.hasUi, true);
    assert.ok(p.stacks.includes('node'));
  } finally { cleanup(dir); }
});

test('detects OpenTofu from its provider lock file', () => {
  const dir = fixture({
    'main.tf': 'terraform {}',
    '.terraform.lock.hcl': 'provider "registry.opentofu.org/hashicorp/random" {}',
  });
  try {
    assert.equal(detectProfile(dir).iac, 'opentofu');
  } finally { cleanup(dir); }
});

test('uses the architecture IaC choice until a provider lockfile identifies the tool', () => {
  const dir = fixture({ 'main.tf': 'terraform {}' });
  try {
    assert.equal(detectProfile(dir).iac, 'terraform');
    assert.equal(detectProfile(dir, { iac: 'OpenTofu' }).iac, 'opentofu');
  } finally { cleanup(dir); }
});

test('unknown project fails rather than passing silently', async () => {
  const dir = fixture({ 'README.md': 'No source project' });
  try {
    const r = await runQualityGates(dir);
    assert.equal(r.ok, false);
    assert.equal(r.checks[0].status, 'failed');
    assert.equal(r.checks[0].required, true);
  } finally { cleanup(dir); }
});

test('release fails a missing IaC lockfile without running init or validate', async () => {
  const dir = fixture({ 'main.tf': 'terraform {}' });
  const calls = [];
  const runner = (binary, args) => {
    calls.push([binary, ...args]);
    return success();
  };
  try {
    const r = await runQualityGates(dir, { stage: 'release', runner });
    assert.equal(r.ok, false);
    assert.equal(r.checks.find((x) => x.name === 'iac-lockfile').status, 'failed');
    assert.equal(r.checks.find((x) => x.name === 'iac-validate').status, 'failed');
    assert.equal(calls.some((x) => x.includes('init') || x.includes('validate')), false);
  } finally { cleanup(dir); }
});

test('release requires a committed NuGet lockfile instead of creating one', async () => {
  const dir = fixture({
    'src/App.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web" />',
    'tests/App.Tests.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
    '.github/workflows/ci.yml': 'name: Quality gates\non:\n  push:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  checks:\n    steps:\n      - uses: actions/checkout@v4\n',
  });
  const calls = [];
  const runner = (binary, args) => {
    calls.push([binary, ...args]);
    return success();
  };
  try {
    const r = await runQualityGates(dir, { stage: 'release', runner });
    assert.equal(r.ok, false);
    assert.equal(r.checks.find((x) => x.name === 'nuget-lockfile').status, 'failed');
    assert.equal(calls.some((x) => x.includes('restore')), false);
  } finally { cleanup(dir); }
});

test('release requires Playwright and blocks a failing test command', async () => {
  const dir = fixture({
    'package.json': JSON.stringify({
      name: 'web', dependencies: { react: '1', '@playwright/test': '1' },
      scripts: { test: 'node --test', 'test:integration': 'node --test' },
    }),
    'public/index.html': '<main>app</main>',
    '.github/workflows/ci.yml': 'name: Quality gates\non:\n  push:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  checks:\n    steps:\n      - uses: actions/checkout@v4\n',
  });
  const calls = [];
  const runner = (binary, args) => {
    calls.push([binary, ...args]);
    return binary === 'npm' && args.includes('test') ? { status: 1, stdout: '', stderr: 'failing test', error: '' } : success();
  };
  try {
    const r = await runQualityGates(dir, { stage: 'release', runner });
    assert.equal(r.ok, false);
    assert.equal(r.checks.find((x) => x.name === 'test').status, 'failed');
    assert.equal(r.checks.find((x) => x.name === 'test:e2e').status, 'failed');
    assert.ok(calls.some((x) => x.includes('audit')));
  } finally { cleanup(dir); }
});

test('detects obvious committed secrets', () => {
  const dir = fixture({ 'src/config.cs': 'var key = "AKIA1234567890ABCDEF";' });
  try { assert.match(secretFindings(dir)[0], /AWS access key/); }
  finally { cleanup(dir); }
});

test('generated CI is checks-only and existing workflows are not overwritten', () => {
  const dir = fixture({ 'package.json': JSON.stringify({ name: 'api', dependencies: { express: '1' } }) });
  try {
    const profile = detectProfile(dir);
    const created = ensureCiWorkflow(dir, profile);
    assert.equal(created.created, true);
    const text = fs.readFileSync(created.path, 'utf8');
    assert.match(text, /permissions:\n  contents: read/);
    assert.doesNotMatch(text, /secrets\.|apply|deploy|publish/i);
    assert.deepEqual(workflowViolations(dir), []);
    fs.writeFileSync(created.path, fs.readFileSync(created.path, 'utf8') + '\n      - run: terraform apply -auto-approve\n');
    assert.ok(workflowViolations(dir).some((x) => /deploy/.test(x)));
    assert.equal(ensureCiWorkflow(dir, profile).created, false);
  } finally { cleanup(dir); }
});

test('release rejects a CI workflow that grants write permissions', async () => {
  const dir = fixture({
    'package.json': JSON.stringify({
      name: 'api',
      dependencies: { express: '1' },
      scripts: { test: 'node --test', lint: 'eslint .', 'format:check': 'prettier --check .', 'test:unit': 'node --test', 'test:integration': 'node --test' },
    }),
    'package-lock.json': '{}',
    'test/api.test.mjs': 'import test from "node:test"; test("example", () => {});',
    '.github/workflows/ci.yml': [
      'name: Quality gates', 'on:', '  push:', 'permissions:', '  contents: read', '  id-token: write',
      'jobs:', '  checks:', '    steps:', '      - uses: actions/checkout@v4', '      - run: npm ci --ignore-scripts',
      '      - run: npm test', '      - run: npm audit --audit-level=high', '      - run: semgrep scan --error .',
      '      - run: npm run lint', '      - run: npm run format:check', '      - run: npm run test:unit',
      '      - run: npm run test:integration', '',
    ].join('\n'),
  });
  try {
    const r = await runQualityGates(dir, { stage: 'release', runner: () => success() });
    assert.equal(r.checks.find((x) => x.name === 'ci-workflow-policy').status, 'failed');
    assert.match(r.checks.find((x) => x.name === 'ci-workflow-policy').detail, /write permissions/);
  } finally { cleanup(dir); }
});
