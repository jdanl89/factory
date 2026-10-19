import fs from 'node:fs';
const out = new URL('./state/pull-progress.txt', import.meta.url);
const model = process.argv[2] || 'qwen3-coder:30b';
const res = await fetch('http://127.0.0.1:11434/api/pull', { method: 'POST', body: JSON.stringify({ model, stream: true }) });
let buf = '', last = 0;
const dec = new TextDecoder();
for await (const c of res.body) {
  buf += dec.decode(c, { stream: true });
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!l) continue;
    const j = JSON.parse(l);
    const pct = j.total ? ` ${(100 * (j.completed || 0) / j.total).toFixed(1)}% of ${(j.total / 1e9).toFixed(1)}GB` : '';
    if (Date.now() - last > 3000 || !j.total || j.error) { last = Date.now(); fs.writeFileSync(out, `${new Date().toISOString()} ${j.status || ''}${pct} ${j.error || ''}\n`); }
  }
}
fs.writeFileSync(out, `${new Date().toISOString()} DONE\n`);
