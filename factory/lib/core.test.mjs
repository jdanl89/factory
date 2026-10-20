import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontMatter } from './core.mjs';

test('parses block labels, folded titles and parent ids', () => {
  const y = parseFrontMatter([
    'id: TASK-8.10', 'title: >-', '  P3: Add audit logging (2/4): Implement audit logging functions for repository', '  operations',
    'status: To Do', 'assignee: []', 'labels:', '  - git-credential-manager', '  - depth-1', '  - blocked', 'dependencies: []', 'parent_task_id: TASK-8', 'ordinal: 25000',
  ].join('\n'));
  assert.equal(y.id, 'TASK-8.10');
  assert.equal(y.title, 'P3: Add audit logging (2/4): Implement audit logging functions for repository operations');
  assert.deepEqual(y.labels, ['git-credential-manager', 'depth-1', 'blocked']);
  assert.equal(y.parent_task_id, 'TASK-8');
  assert.equal(y.status, 'To Do');
});

test('parses inline labels and quoted titles', () => {
  const y = parseFrontMatter(["id: TASK-1", "title: 'P1: Setup: db'", 'labels: [slug, depth-2]', 'status: Done'].join('\r\n'));
  assert.equal(y.title, 'P1: Setup: db');
  assert.deepEqual(y.labels, ['slug', 'depth-2']);
});
