import test from 'node:test';
import assert from 'node:assert/strict';
import { failScore, prioritize, lessons } from './iterate.mjs';

test('failScore counts failing test lines, minimum one per check', () => {
  assert.equal(failScore([{ detail: '✖ a\n  detail\n✖ b' }]), 2);
  assert.equal(failScore([{ detail: 'lint exploded' }, { detail: 'not ok 1 - x' }]), 2);
  assert.equal(failScore([]), 0);
});

test('prioritize puts files named in the failure first, then tests', () => {
  const files = [{ rel: 'src/a.mjs' }, { rel: 'test/b.test.mjs' }, { rel: 'src/repositories.mjs' }];
  const order = prioritize(files, 'AssertionError at D:\\x\\src\\repositories.mjs:58').map((f) => f.rel);
  assert.deepEqual(order, ['src/repositories.mjs', 'test/b.test.mjs', 'src/a.mjs']);
});

test('lessons keeps only the latest entries', () => {
  const t = lessons(['one', 'two', 'three', 'four'], 2);
  assert.ok(!t.includes('one') && !t.includes('two') && t.includes('three') && t.includes('four'));
  assert.equal(lessons([]), '');
});
