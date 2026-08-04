/**
 * Prints the cross-model comparison table from saved eval JSON results.
 * Usage: node eval/compare.mjs eval/results/*.json
 */
import { readFile } from 'node:fs/promises';

const files = process.argv.slice(2);
if (!files.length) throw new Error('pass one or more eval result JSON files');

const runs = [];
for (const f of files) runs.push(JSON.parse(await readFile(f, 'utf8')));

const summarize = (rows) => {
  const valid = rows.filter((r) => !r.invalid);
  const n = valid.length;
  if (!n) return null;
  const at = (k) => valid.filter((r) => r.rank && r.rank <= k).length / n;
  return {
    n,
    'Recall@1': at(1),
    'Recall@5': at(5),
    'Recall@10': at(10),
    'Recall@20': at(20),
    MRR: valid.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / n,
  };
};

const GROUPS = {
  English: (r) => r.language === 'en->en',
  'Hindi/Hinglish': (r) => r.language !== 'en->en',
  'Meeting transcript': (r) => r.category === 'meeting-transcript',
  'Structured SharePoint': (r) => r.category === 'structured',
  'Exact keyword/title': (r) => r.queryType === 'exact-title',
  'Semantic/paraphrased': (r) => r.queryType === 'paraphrased' || r.queryType === 'semantic',
};

const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const W = 16;
const head = ['', ...runs.map((r) => r.label)];
const line = (cells) => cells[0].padEnd(24) + cells.slice(1).map((c) => String(c).padStart(W)).join('');

console.log('\n' + line(head));
console.log('-'.repeat(24 + W * runs.length));

for (const metric of ['Recall@1', 'Recall@5', 'Recall@10', 'Recall@20']) {
  console.log(line([metric, ...runs.map((r) => pct(summarize(r.rows)?.[metric]))]));
}
console.log(line(['MRR', ...runs.map((r) => (summarize(r.rows)?.MRR ?? 0).toFixed(3))]));

console.log('\n' + line(['— Recall@5 by group —', ...runs.map(() => '')]));
console.log('-'.repeat(24 + W * runs.length));
for (const [name, fn] of Object.entries(GROUPS)) {
  console.log(
    line([
      name,
      ...runs.map((r) => {
        const m = summarize(r.rows.filter(fn));
        return m ? `${pct(m['Recall@5'])} (n=${m.n})` : '—';
      }),
    ])
  );
}
console.log('');
