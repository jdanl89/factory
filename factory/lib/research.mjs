import fs from 'node:fs';
import path from 'node:path';
import { ROOT, log, haltCheck } from './core.mjs';

// Read-only market research. GET requests to an allowlist of public, keyless APIs. Nothing is posted, no accounts, no spend.
const ALLOW = new Set(['hn.algolia.com', 'api.stackexchange.com', 'api.github.com', 'lobste.rs', 'dev.to']);
const UA = 'software-factory-research/1.0 (read-only, low-rate)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const yearAgo = () => Math.floor(Date.now() / 1000) - 365 * 86400;
const clean = (s, n = 260) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

async function getJson(url) {
  const host = new URL(url).hostname;
  if (!ALLOW.has(host)) throw new Error('research host not allowlisted: ' + host);
  haltCheck();
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${host} ${res.status}`);
  await sleep(1500);
  return res.json();
}

const HN_QUERIES = [
  'is there a tool', 'is there software', 'looking for software', 'wish there was', 'alternative to',
  'how do you manage', 'tired of', 'would pay for', 'spreadsheet hell', 'small business software',
  'freelancers tool', 'what do you use for', 'too expensive', 'built my own tool because',
];
const SE_SITES = ['softwarerecs', 'webapps', 'pm', 'money', 'ux', 'webmasters', 'softwareengineering', 'workplace', 'expatriates', 'photo', 'diy', 'law'];
// Sites mostly about non-developer problems; sampled more often to counter the developer-heavy bias.
const SE_NON_DEV = new Set(['webapps', 'pm', 'money', 'workplace', 'photo', 'diy', 'law']);

const pick = (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, n);

// ---- Reddit: official app-only OAuth (read-only). Needs human-provided credentials in secrets/reddit.json ----
const REDDIT_SUBS = ['SomebodyMakeThis', 'AppIdeas', 'SaaS', 'microsaas', 'smallbusiness', 'freelance', 'Entrepreneur', 'sysadmin', 'webdev', 'selfhosted'];
function redditCreds() {
  const f = path.join(ROOT, 'secrets', 'reddit.json');
  if (!fs.existsSync(f)) return null;
  try {
    const c = JSON.parse(fs.readFileSync(f, 'utf8'));
    return c.client_id && c.client_secret && !/YOUR_/.test(c.client_id + c.client_secret) ? c : null;
  } catch { return null; }
}
async function redditToken(c) {
  haltCheck();
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: { authorization: 'Basic ' + Buffer.from(`${c.client_id}:${c.client_secret}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded', 'user-agent': c.user_agent || UA },
    body: 'grant_type=client_credentials', signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error('reddit token ' + res.status);
  const j = await res.json();
  if (!j.access_token) throw new Error('reddit token missing: ' + (j.error || 'unknown'));
  return j.access_token;
}
async function redditSignals() {
  const c = redditCreds();
  if (!c) { log('research', { msg: 'reddit skipped: no secrets/reddit.json credentials' }); return []; }
  const token = await redditToken(c);
  const out = [];
  for (const sub of pick(REDDIT_SUBS, 5)) {
    out.push(...await safe('reddit r/' + sub, async () => {
      haltCheck();
      const res = await fetch(`https://oauth.reddit.com/r/${sub}/top?t=month&limit=20&raw_json=1`, { headers: { authorization: 'Bearer ' + token, 'user-agent': c.user_agent || UA }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`reddit ${res.status}`);
      await sleep(1500);
      const j = await res.json();
      // Deliberately drops author names: research collects problems, never personal data about individuals.
      return (j.data?.children || []).map((x) => x.data).filter((d) => d && !d.over_18 && !d.stickied)
        .map((d) => ({ source: 'reddit:r/' + sub, title: clean(d.title, 160), text: clean(d.selftext, 320), score: d.score ?? 0, comments: d.num_comments ?? 0, url: 'https://www.reddit.com' + d.permalink }));
    }));
  }
  return out;
}

async function safe(label, fn) {
  try { return await fn(); } catch (e) { log('research-source-failed', { msg: `${label}: ${e.message}` }); return []; }
}

export async function gatherSignals() {
  const signals = [];
  for (const q of pick(HN_QUERIES, 6)) {
    signals.push(...await safe('hn ' + q, async () => {
      const u = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent('"' + q + '"')}&tags=ask_hn&numericFilters=${encodeURIComponent(`created_at_i>${yearAgo()},num_comments>=3`)}&hitsPerPage=8`;
      const j = await getJson(u);
      return j.hits.map((h) => ({ source: 'hackernews', title: clean(h.title, 160), text: clean(h.story_text, 320), score: h.points ?? 0, comments: h.num_comments ?? 0, url: `https://news.ycombinator.com/item?id=${h.objectID}` }));
    }));
  }
  for (const site of [...pick(SE_SITES.filter((s) => SE_NON_DEV.has(s)), 3), ...pick(SE_SITES.filter((s) => !SE_NON_DEV.has(s)), 2)]) {
    signals.push(...await safe('stackexchange ' + site, async () => {
      const u = `https://api.stackexchange.com/2.3/questions?order=desc&sort=votes&site=${site}&fromdate=${yearAgo()}&pagesize=10&filter=default`;
      const j = await getJson(u);
      return (j.items || []).map((i) => ({ source: 'stackexchange:' + site, title: clean(i.title, 160), text: (i.tags || []).join(', '), score: i.score, comments: i.answer_count, url: i.link }));
    }));
  }
  signals.push(...await safe('github', async () => {
    const q = encodeURIComponent('is:issue is:open label:enhancement comments:>10 sort:reactions');
    const j = await getJson(`https://api.github.com/search/issues?q=${q}&per_page=10`);
    return (j.items || []).map((i) => ({ source: 'github-feature-request', title: clean(i.title, 160), text: clean(i.body, 240), score: i.reactions?.total_count ?? 0, comments: i.comments, url: i.html_url }));
  }));
  signals.push(...await safe('hn show', async () => {
    const j = await getJson(`https://hn.algolia.com/api/v1/search?tags=show_hn&numericFilters=${encodeURIComponent(`created_at_i>${yearAgo()},num_comments>=10`)}&hitsPerPage=12`);
    return j.hits.map((h) => ({ source: 'hackernews:show', title: clean(h.title, 160), text: clean(h.story_text || h.url, 200), score: h.points ?? 0, comments: h.num_comments ?? 0, url: `https://news.ycombinator.com/item?id=${h.objectID}` }));
  }));
  signals.push(...await safe('lobsters', async () => {
    const j = await getJson('https://lobste.rs/hottest.json');
    return j.map((s) => ({ source: 'lobsters', title: clean(s.title, 160), text: clean(s.description_plain, 200) || (s.tags || []).join(', '), score: s.score ?? 0, comments: s.comment_count ?? 0, url: s.comments_url }));
  }));
  signals.push(...await safe('devto', async () => {
    const j = await getJson(`https://dev.to/api/articles?top=30&per_page=15&tag=${pick(['webdev', 'productivity', 'saas', 'startup', 'career', 'freelance'], 1)[0]}`);
    return j.map((a) => ({ source: 'devto', title: clean(a.title, 160), text: clean(a.description, 200), score: a.positive_reactions_count ?? 0, comments: a.comments_count ?? 0, url: a.url }));
  }));
  signals.push(...await safe('reddit', redditSignals));
  const seen = new Set();
  const uniq = signals.filter((s) => s.title && !seen.has(s.url) && seen.add(s.url));
  // Round-robin across source groups (best-scoring first within each) so no single source dominates.
  const groups = new Map();
  for (const s of uniq.sort((a, b) => (b.score + b.comments) - (a.score + a.comments))) {
    const g = s.source.split(':')[0];
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  const out = [];
  while (out.length < 60 && [...groups.values()].some((g) => g.length)) for (const g of groups.values()) if (g.length && out.length < 60) out.push(g.shift());
  return out;
}

export function loadFreshResearch(maxAgeHours = 12) {
  const dir = path.join(ROOT, 'research');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) return null;
  const f = path.join(dir, files.at(-1));
  return Date.now() - fs.statSync(f).mtimeMs < maxAgeHours * 3600e3 ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}
export function saveResearch(obj) {
  const dir = path.join(ROOT, 'research');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, new Date().toISOString().replace(/[:.]/g, '-') + '.json'), JSON.stringify(obj, null, 2));
}
