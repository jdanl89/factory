// Helpers for the build retry loop: score failures, order context so failing files are never truncated away.

// Number of failing tests/checks. Each failed check counts at least 1; every "✖"/"not ok" line adds detail.
export function failScore(failedChecks) {
  let n = 0;
  for (const c of failedChecks) {
    const lines = String(c.detail || '').split(/\r?\n/).filter((l) => /^\s*(✖|×|not ok)\s/.test(l)).length;
    n += Math.max(1, lines);
  }
  return n;
}

// Files mentioned in the failure text or task come first, then tests, then the rest.
export function prioritize(files, focus) {
  const f = String(focus || '').replace(/\\/g, '/').toLowerCase();
  const rank = (rel) => {
    const r = rel.toLowerCase();
    if (f.includes(r) || f.includes(r.split('/').pop())) return 0;
    return /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\./.test(r) ? 1 : 2;
  };
  return [...files].sort((a, b) => rank(a.rel) - rank(b.rel) || a.rel.localeCompare(b.rel));
}

// Compact memory of earlier failed attempts so the model stops repeating them.
export function lessons(history, keep = 3, each = 350) {
  const h = history.slice(-keep);
  return h.length ? '\nEarlier failed attempts (do not repeat these mistakes):\n' + h.map((x) => `- ${String(x).replace(/\s+/g, ' ').slice(0, each)}`).join('\n') + '\n' : '';
}
