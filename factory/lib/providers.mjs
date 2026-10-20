import fs from 'node:fs';
import path from 'node:path';

// Model specs: "qwen3:8b" (local Ollama) or "<provider>:<model>" where <provider> is a key of cfg.providers,
// e.g. "github:openai/gpt-4.1". A role may also list several specs; they are tried in order (fallback chain).
export function parseSpec(spec, providers = {}) {
  const i = spec.indexOf(':');
  if (i > 0) {
    const name = spec.slice(0, i);
    if (Object.hasOwn(providers, name)) return { provider: name, model: spec.slice(i + 1), conf: providers[name] };
  }
  return { provider: 'ollama', model: spec };
}
export const specsFor = (value) => [].concat(value ?? []).filter(Boolean);

const day = () => new Date().toISOString().slice(0, 10);
export function usageFile(stateDir) { return path.join(stateDir, 'usage.json'); }
export function readUsage(stateDir) {
  try { const u = JSON.parse(fs.readFileSync(usageFile(stateDir), 'utf8')); return u.day === day() ? u : { day: day(), tokens: {} }; }
  catch { return { day: day(), tokens: {} }; }
}
export function addUsage(stateDir, provider, tokens) {
  const u = readUsage(stateDir);
  u.tokens[provider] = (u.tokens[provider] || 0) + tokens;
  fs.writeFileSync(usageFile(stateDir), JSON.stringify(u, null, 2));
}

// Returns a reason string if the provider must not be used right now, else null.
export function blockedReason(name, conf, stateDir, env = process.env) {
  if (!conf.enabled) return `provider '${name}' is disabled (human must set providers.${name}.enabled=true in factory.config.json)`;
  if (!env[conf.apiKeyEnv]) return `environment variable ${conf.apiKeyEnv} is not set`;
  const cap = Number(conf.dailyTokenCap);
  if (!(cap > 0)) return `providers.${name}.dailyTokenCap must be a positive number`;
  const used = readUsage(stateDir).tokens[name] || 0;
  if (used >= cap) return `daily token cap reached (${used}/${cap})`;
  return null;
}

export async function callRemote(name, conf, model, system, user, { json = false, temperature = 0.4 } = {}, env = process.env) {
  const key = env[conf.apiKeyEnv];
  const signal = AbortSignal.timeout(conf.timeoutMs || 600000);
  const max = conf.maxOutputTokens || 8192;
  if (json) system += '\n\nReply with a single valid JSON value only, with no markdown fences or commentary.';
  let res, headers, url, body;
  if (conf.type === 'anthropic') {
    url = conf.baseUrl.replace(/\/+$/, '') + '/v1/messages';
    headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': conf.apiVersion || '2023-06-01' };
    body = { model, max_tokens: max, temperature, system, messages: [{ role: 'user', content: user }] };
  } else if (conf.type === 'openai') {
    url = conf.baseUrl.replace(/\/+$/, '') + (conf.chatPath || '/chat/completions');
    headers = { 'content-type': 'application/json', authorization: 'Bearer ' + key, ...(conf.headers || {}) };
    body = { model, temperature, max_tokens: max, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  } else throw new Error(`provider '${name}': unknown type '${conf.type}' (use 'openai' or 'anthropic')`);
  res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  const text = await res.text();
  if (!res.ok) throw new Error(`${name} ${res.status}: ${text.slice(0, 300).replace(key, '***')}`);
  const j = JSON.parse(text);
  if (conf.type === 'anthropic') {
    return { content: (j.content || []).map((c) => c.text || '').join(''), tokens: (j.usage?.input_tokens || 0) + (j.usage?.output_tokens || 0) };
  }
  return { content: j.choices?.[0]?.message?.content ?? '', tokens: j.usage?.total_tokens || 0 };
}

export function stripJsonFences(s) {
  const m = s.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1] : s;
}
