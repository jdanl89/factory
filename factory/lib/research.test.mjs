import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSource, deepRead, verifyQuotes, marketCheck, sourceText } from './research.mjs';

test('parseSource recognises supported sources only', () => {
  assert.deepEqual(parseSource('https://github.com/desktop/desktop/issues/3707'), { kind: 'github', owner: 'desktop', repo: 'desktop', n: '3707' });
  assert.equal(parseSource('https://github.com/a/b/pull/2'), null);
  assert.deepEqual(parseSource('https://news.ycombinator.com/item?id=42'), { kind: 'hn', id: '42' });
  assert.equal(parseSource('https://softwarerecs.stackexchange.com/questions/9/x').kind, 'se');
  assert.equal(parseSource('https://evil.example/issues/1'), null);
  assert.equal(parseSource('not a url'), null);
});

test('verifyQuotes keeps only verbatim excerpts', () => {
  const texts = ['I really want to   switch between my work and personal GitHub accounts easily'];
  const q = verifyQuotes(['switch between my work and personal github accounts', 'users want a web dashboard', 'short'], texts);
  assert.deepEqual(q, ['switch between my work and personal github accounts']);
});

test('deepRead and marketCheck use fetched data', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const body = u.includes('/comments') ? [{ body: 'me too, I need profiles in the app', reactions: { total_count: 5 } }]
      : u.includes('/issues/3707') ? { title: 'Multiple accounts', body: 'Please add profile switching to the app', comments: 1 }
      : u.includes('registry.npmjs.org') ? { objects: [{ package: { name: 'git-profile', description: 'switch git identity', links: { npm: 'https://npm/git-profile' }, date: '2025-01-01T00:00:00Z' } }] }
      : u.includes('search/repositories') ? { items: [{ full_name: 'o/gp', description: 'd', html_url: 'https://github.com/o/gp', stargazers_count: 9, pushed_at: '2025-02-02T00:00:00Z' }] } : {};
    return { ok: true, json: async () => body };
  };
  try {
    const d = await deepRead('https://github.com/desktop/desktop/issues/3707');
    assert.equal(d.title, 'Multiple accounts');
    assert.match(sourceText(d), /profile switching/);
    assert.equal(d.comments.length, 1);
    const m = await marketCheck(['git profile switcher']);
    assert.deepEqual(m.map((x) => x.source), ['npm', 'github']);
  } finally { globalThis.fetch = real; }
});

test('opportunityScore is bounded and rewards independent lenses', async () => {
  const { opportunityScore } = await import('./research.mjs');
  const one = opportunityScore({ scores: { pain: 3, payment: 3, gap: 3, timing: 3, buildability: 3 }, lenses: ['paying'], evidence: ['a'] });
  const two = opportunityScore({ scores: { pain: 3, payment: 3, gap: 3, timing: 3, buildability: 3 }, lenses: ['paying', 'gap'], evidence: ['a', 'b'] });
  assert.ok(two > one);
  assert.ok(opportunityScore({ scores: { pain: 99, payment: 99, gap: 99, timing: 99, buildability: 99 }, lenses: ['a', 'paying', 'gap', 'trend', 'nondev'], evidence: ['a', 'b'] }) <= 5 * 9.5 + 4);
  assert.ok(opportunityScore({}) >= 9.5);
});

test('parseSource handles repositories', () => {
  assert.deepEqual(parseSource('https://github.com/a/b'), { kind: 'repo', owner: 'a', repo: 'b' });
});
