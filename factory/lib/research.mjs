import fs from 'node:fs';
import path from 'node:path';
import { ROOT, log, haltCheck } from './core.mjs';

// Read-only market research. GET requests to an allowlist of public, keyless APIs. Nothing is posted, no accounts, no spend.
const ALLOW = new Set(['hn.algolia.com', 'api.stackexchange.com', 'api.github.com', 'lobste.rs', 'dev.to', 'registry.npmjs.org']);
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
const SE_SITES = ['softwarerecs', 'webapps', 'pm', 'money', 'ux', 'webmasters', 'softwareengineering', 'workplace', 'expatriates', 'photo', 'diy', 'law', 'startups', 'academia', 'fitness', 'gardening', 'mechanics'];
// Sites mostly about non-developer problems; sampled more often to counter the developer-heavy bias.
const SE_NON_DEV = new Set(['webapps', 'pm', 'money', 'workplace', 'photo', 'diy', 'law', 'startups', 'academia', 'fitness', 'gardening', 'mechanics']);

const pick = (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, n);

// ---- ideation lenses: each produces signals tagged with WHY they matter ----
const monthsAgo = (m) => Math.floor(Date.now() / 1000) - m * 30 * 86400;
const PAYING_QUERIES = ['MRR', 'monthly recurring revenue', 'paying customers', 'made $ per month', 'first paying customer', 'bootstrapped', 'revenue'];
const GAP_QUERIES = ['is shutting down', 'sunsetting', 'raising prices', 'price hike', 'alternative to', 'self-hosted alternative', 'open source alternative', 'is being discontinued'];
const hnHit = (lens) => (h) => ({ source: 'hackernews', lens, title: clean(h.title, 160), text: clean(h.story_text || h.url, 320), score: h.points ?? 0, comments: h.num_comments ?? 0, url: `https://news.ycombinator.com/item?id=${h.objectID}` });

export async function lensSignals() {
  const out = [];
  for (const q of pick(PAYING_QUERIES, 3)) {
    out.push(...await safe('paying ' + q, async () => {
      const j = await getJson(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent('"' + q + '"')}&tags=show_hn&numericFilters=${encodeURIComponent(`created_at_i>${monthsAgo(18)},points>=15`)}&hitsPerPage=8`);
      return j.hits.map(hnHit('paying'));
    }));
  }
  for (const q of pick(GAP_QUERIES, 3)) {
    out.push(...await safe('gap ' + q, async () => {
      const j = await getJson(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent('"' + q + '"')}&tags=story&numericFilters=${encodeURIComponent(`created_at_i>${monthsAgo(18)},points>=60,num_comments>=25`)}&hitsPerPage=8`);
      return j.hits.map(hnHit('gap'));
    }));
  }
  // Trends: brand-new repositories that gained stars fastest across all topics, i.e. what builders and users are flocking to.
  out.push(...await safe('trend repos', async () => {
    const since = new Date(Date.now() - 90 * 86400e3).toISOString().slice(0, 10);
    const j = await getJson(`https://api.github.com/search/repositories?q=${encodeURIComponent('created:>' + since + ' stars:>300')}&sort=stars&per_page=15`);
    return (j.items || []).map((r) => ({ source: 'github-trending', lens: 'trend', title: clean(r.full_name + ': ' + (r.description || ''), 160), text: (r.topics || []).join(', '), score: r.stargazers_count, comments: r.forks_count, url: r.html_url }));
  }));
  return out;
}

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
      return (j.items || []).map((i) => ({ source: 'stackexchange:' + site, lens: SE_NON_DEV.has(site) ? 'nondev' : undefined, title: clean(i.title, 160), text: (i.tags || []).join(', '), score: i.score, comments: i.answer_count, url: i.link }));
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
  signals.push(...await lensSignals());
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
  while (out.length < 80 && [...groups.values()].some((g) => g.length)) for (const g of groups.values()) if (g.length && out.length < 80) out.push(g.shift());
  return out;
}

// ---- deep read: full text of a cited source (body + top comments), read-only, no author names ----
export function parseSource(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  let m;
  if (u.hostname === 'github.com' && (m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/(issues|pull|discussions)\/(\d+)/)) && m[3] === 'issues') return { kind: 'github', owner: m[1], repo: m[2], n: m[4] };
  if (u.hostname === 'github.com' && (m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/))) return { kind: 'repo', owner: m[1], repo: m[2] };
  if (u.hostname === 'news.ycombinator.com' && (m = u.searchParams.get('id'))) return { kind: 'hn', id: m };
  if (/\.stackexchange\.com$/.test(u.hostname) && (m = u.pathname.match(/^\/questions\/(\d+)/))) return { kind: 'se', site: u.hostname, id: m[1] };
  return null;
}
const tidy = (s, n) => clean(s, n);
export async function deepRead(url) {
  const src = parseSource(url);
  if (!src) return null;
  try {
    if (src.kind === 'github') {
      const base = `https://api.github.com/repos/${src.owner}/${src.repo}/issues/${src.n}`;
      const issue = await getJson(base);
      const cs = await getJson(base + '/comments?per_page=100');
      const ranked = [...cs].sort((a, b) => (b.reactions?.total_count ?? 0) - (a.reactions?.total_count ?? 0));
      const picked = [...new Set([...cs.slice(0, 6), ...ranked.slice(0, 6)])].slice(0, 12);
      return { url, host: `github.com/${src.owner}/${src.repo}`, title: tidy(issue.title, 200), body: tidy(issue.body, 3000), comments: picked.map((c) => tidy(c.body, 600)) };
    }
    if (src.kind === 'repo') {
      const r = await getJson(`https://api.github.com/repos/${src.owner}/${src.repo}`);
      const rd = await getJson(`https://api.github.com/repos/${src.owner}/${src.repo}/readme`).catch(() => null);
      const readme = rd?.content ? Buffer.from(rd.content, 'base64').toString('utf8') : '';
      return { url, host: `github.com/${src.owner}/${src.repo}`, title: tidy(`${r.full_name}: ${r.description || ''}`, 200), body: tidy(readme, 3000), comments: [] };
    }
    if (src.kind === 'hn') {
      const j = await getJson(`https://hn.algolia.com/api/v1/items/${src.id}`);
      const top = (j.children || []).filter((c) => c.text).sort((a, b) => (b.points ?? 0) - (a.points ?? 0)).slice(0, 10);
      return { url, host: 'news.ycombinator.com', title: tidy(j.title, 200), body: tidy(j.text, 3000), comments: top.map((c) => tidy(c.text, 600)) };
    }
    if (src.kind === 'se') {
      const site = src.site.replace(/\.stackexchange\.com$/, '');
      const q = await getJson(`https://api.stackexchange.com/2.3/questions/${src.id}?site=${site}&filter=withbody`);
      const a = await getJson(`https://api.stackexchange.com/2.3/questions/${src.id}/answers?site=${site}&filter=withbody&sort=votes&pagesize=5`);
      const it = q.items?.[0];
      if (!it) return null;
      return { url, host: src.site, title: tidy(it.title, 200), body: tidy(it.body, 3000), comments: (a.items || []).map((x) => tidy(x.body, 600)) };
    }
  } catch (e) { log('research-source-failed', { msg: `deep-read ${url}: ${e.message}` }); }
  return null;
}
export const sourceText = (d) => [d.title, d.body, ...d.comments].join('\n');

// A quote counts only if it appears verbatim (ignoring case/whitespace) in the fetched sources.
export function verifyQuotes(quotes, texts) {
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
  const hay = texts.map(norm);
  return (quotes || []).map(String).filter((q) => norm(q).length >= 12 && hay.some((h) => h.includes(norm(q))));
}

// Weighted, bounded score so one inflated number cannot dominate; a second independent lens earns a bonus.
export function opportunityScore(o) {
  const s = o.scores || {};
  const n = (k) => Math.min(5, Math.max(1, Number(s[k]) || 1));
  const lenses = new Set((o.lenses || []).filter((l) => ['paying', 'gap', 'nondev', 'trend'].includes(l)));
  const base = n('pain') * 2 + n('payment') * 3 + n('gap') * 2 + n('timing') + n('buildability') * 1.5;
  return Math.round((base + Math.min(3, lenses.size - 1 > 0 ? (lenses.size - 1) * 2 : 0) + (o.evidence?.length > 1 ? 1 : 0)) * 10) / 10;
}

// ---- market check: what already exists (npm packages, GitHub repositories) ----
export async function marketCheck(terms, per = 5) {
  const out = [];
  for (const t of (terms || []).slice(0, 3)) {
    const q = encodeURIComponent(String(t).slice(0, 80));
    const npm = await getJson(`https://registry.npmjs.org/-/v1/search?text=${q}&size=${per}`).catch(() => ({ objects: [] }));
    for (const o of npm.objects || []) out.push({ term: t, source: 'npm', name: o.package.name, description: tidy(o.package.description, 140), url: o.package.links?.npm, updated: (o.package.date || '').slice(0, 10) });
    const gh = await getJson(`https://api.github.com/search/repositories?q=${q}&sort=stars&per_page=${per}`).catch(() => ({ items: [] }));
    for (const r of gh.items || []) out.push({ term: t, source: 'github', name: r.full_name, description: tidy(r.description, 140), url: r.html_url, stars: r.stargazers_count, updated: (r.pushed_at || '').slice(0, 10) });
  }
  const seen = new Set();
  return out.filter((x) => x.url && !seen.has(x.url) && seen.add(x.url));
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
