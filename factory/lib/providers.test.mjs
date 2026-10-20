import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { parseSpec, specsFor, blockedReason, addUsage, readUsage, callRemote, stripJsonFences } from './providers.mjs';

const providers = { github: { type: 'openai' }, anthropic: { type: 'anthropic' } };

test('parseSpec keeps ollama tags and detects providers', () => {
  assert.deepEqual(parseSpec('qwen3:8b', providers), { provider: 'ollama', model: 'qwen3:8b' });
  const g = parseSpec('github:openai/gpt-4.1', providers);
  assert.equal(g.provider, 'github'); assert.equal(g.model, 'openai/gpt-4.1');
  assert.equal(parseSpec('unknown:x', providers).provider, 'ollama');
  assert.deepEqual(specsFor(['a', 'b']), ['a', 'b']); assert.deepEqual(specsFor('a'), ['a']);
});

test('blockedReason enforces opt-in, key and daily cap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-'));
  const conf = { enabled: false, apiKeyEnv: 'K', dailyTokenCap: 100 };
  assert.match(blockedReason('x', conf, dir, { K: 's' }), /disabled/);
  conf.enabled = true;
  assert.match(blockedReason('x', conf, dir, {}), /not set/);
  assert.equal(blockedReason('x', conf, dir, { K: 's' }), null);
  addUsage(dir, 'x', 100);
  assert.equal(readUsage(dir).tokens.x, 100);
  assert.match(blockedReason('x', conf, dir, { K: 's' }), /cap reached/);
  assert.match(blockedReason('x', { ...conf, dailyTokenCap: undefined }, dir, { K: 's' }), /dailyTokenCap/);
});

test('callRemote speaks openai and anthropic dialects', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => {
      seen.push({ url: req.url, h: req.headers, b: JSON.parse(b) });
      res.setHeader('content-type', 'application/json');
      res.end(req.url.endsWith('/messages')
        ? JSON.stringify({ content: [{ text: '{"a":1}' }], usage: { input_tokens: 3, output_tokens: 4 } })
        : JSON.stringify({ choices: [{ message: { content: '```json\n{"a":1}\n```' } }], usage: { total_tokens: 9 } }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const env = { K: 'secret' };
  const o = await callRemote('github', { type: 'openai', baseUrl: base, apiKeyEnv: 'K' }, 'm', 'sys', 'usr', { json: true }, env);
  assert.equal(o.tokens, 9); assert.deepEqual(JSON.parse(stripJsonFences(o.content)), { a: 1 });
  assert.equal(seen[0].h.authorization, 'Bearer secret');
  assert.match(seen[0].b.messages[0].content, /JSON/);
  const a = await callRemote('anthropic', { type: 'anthropic', baseUrl: base, apiKeyEnv: 'K' }, 'm', 'sys', 'usr', {}, env);
  assert.equal(a.tokens, 7); assert.equal(seen[1].h['x-api-key'], 'secret'); assert.equal(seen[1].b.system, 'sys');
  srv.close();
});

test('callRemote errors do not leak the key', async () => {
  const srv = http.createServer((req, res) => { res.statusCode = 401; res.end('bad key secret'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  await assert.rejects(
    callRemote('p', { type: 'openai', baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKeyEnv: 'K' }, 'm', 's', 'u', {}, { K: 'secret' }),
    (e) => /401/.test(e.message) && !e.message.includes('secret'));
  srv.close();
});
