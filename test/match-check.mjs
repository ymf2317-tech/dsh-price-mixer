// Offline check for the 0.3.0 matching engine.
//
//   node test/match-check.mjs [path/to/models.dev-api.json] [--verbose]
//
// Reads the real models.dev book (dumped to a local file), lets the plugin
// discover the models from THIS machine's DSH profile, and prints what would be
// injected. No network, no host, no keys.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const bookPath = args.find((a) => !a.startsWith('--')) ?? join(tmpdir(), 'md.json');

if (!existsSync(bookPath)) {
  console.error(`book not found: ${bookPath}`);
  process.exit(2);
}

const book = JSON.parse(readFileSync(bookPath, 'utf8'));
const plugin = await import('../lib/index.js');
const { discoverModels, buildBookIndex, resolveModel, readStore, parseQuery, scorePair } = plugin.__test;
const t0 = Date.now();
const discovery = discoverModels(true);
const t1 = Date.now();
const index = buildBookIndex(book);
const t2 = Date.now();
const { overrides, aliases } = readStore();

console.log(`timing: discovery ${t1 - t0}ms, index ${t2 - t1}ms (${index.total} entries)`);
console.log(`book: ${Object.keys(book).length} providers, ${index.total} priced model entries`);
console.log(`config files:`);
for (const file of discovery.files) {
  console.log(`  ${file.exists ? '✓' : '✗'} ${file.path}  providers=${file.providers} models=${file.models}${file.error ? ` error=${file.error}` : ''}`);
}
console.log(`configured: ${discovery.total} models in ${discovery.providers.length} provider(s)${discovery.fallback ? ' (FALLBACK LIST)' : ''}`);
console.log(`config file: ${plugin.__test.CONFIG_PATH} overrides=${Object.keys(overrides).length} aliases=${Object.keys(aliases).length}`);
console.log('');

const rows = [];
const t3 = Date.now();
for (const provider of discovery.providers) {
  for (const id of provider.models) {
    rows.push({ provider: provider.name, ...resolveModel(id, index, aliases, overrides) });
  }
}
console.log(`timing: resolve ${Date.now() - t3}ms for ${rows.length} models`);

const width = Math.max(...rows.map((r) => r.id.length), 6);
const pad = (s, n) => String(s).padEnd(n);
const fmt = (v) => (typeof v === 'number' ? String(Math.round(v * 10000) / 10000) : '—');

const counts = {};
for (const row of rows) {
  counts[row.status] = (counts[row.status] ?? 0) + 1;
  const q = parseQuery(row.id, index);
  const slots = `fam=${q.family ?? '?'} ver=${q.version ?? '—'} tier=${q.tier ?? '—'} extra=[${q.extras.join(',')}]`;
  console.log(
    `${pad(row.status, 11)} ${pad(row.id, width)}  ${pad(row.canonical ?? '', 42)} ` +
    `${row.score != null ? `score=${String(row.score).padStart(5)}` : '          '} ` +
    `in=${fmt(row.cost?.input)} out=${fmt(row.cost?.output)} cr=${fmt(row.cost?.cache_read)}  | ${slots}`,
  );
  if (verbose || row.status === 'pending') {
    if (row.reason) console.log(`${' '.repeat(12)}reason: ${row.reason}`);
    for (const cand of row.candidates ?? []) {
      console.log(`${' '.repeat(12)}cand ${cand.score} ${cand.canonical}  in=${fmt(cand.input)} out=${fmt(cand.output)}  (${cand.reasons.join(' ')})`);
    }
  }
}

console.log('');
console.log('summary:', Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' '));

// No injected price may be 0/0 (that is a subscription plan, not a rate).
// Manual overrides are the user's own numbers and are exempt.
const zeros = rows.filter((r) => r.cost && r.status !== 'manual' && r.cost.input === 0 && r.cost.output === 0);
if (zeros.length > 0) {
  console.log(`FAIL: ${zeros.length} row(s) priced at 0/0: ${zeros.map((r) => `${r.id}<-${r.canonical}`).join(', ')}`);
  process.exitCode = 1;
}

// Anchor test: the user's裁定 — kimi-k3-1 is kimi-k3.1, not kimi-k3. Checked on
// a clean store so a saved manual price cannot hide a matcher regression.
const cleanMatch = resolveModel('kimi-k3-1', index, {}, {});
const anchorOk = /kimi-k3\.1/.test(cleanMatch.canonical ?? '');
console.log(`anchor kimi-k3-1 -> ${cleanMatch.canonical ?? '—'} (${cleanMatch.status}) ${anchorOk ? 'OK' : 'FAIL'}`);
if (!anchorOk) process.exitCode = 1;

// Gateway prefixes and reseller suffixes must not hide the family.
const prefixCases = [
  ['gateway-deepseek-v4-flash-tencent', /deepseek-v4-flash$/],
  ['gateway-glm-5.2', /glm-5\.2$/],
  ['ms-kimi-k3', /kimi-k3$/],
  ['ali-minimax/minimax-m3', /minimax-m3$/i],
];
for (const [id, pattern] of prefixCases) {
  const res = resolveModel(id, index, {}, {});
  const ok = pattern.test(res.canonical ?? '');
  console.log(`prefix ${id} -> ${res.canonical ?? '—'} (${res.status}) ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) process.exitCode = 1;
}

// Every unpriced row must explain itself in Chinese, and no row may carry a
// price from a status we do not consider settled.
const UNPRICED = new Set(['none', 'pending', 'alias-stale', 'waiting', 'alias-none']);
for (const row of rows) {
  if (UNPRICED.has(row.status) && !/[一-龥]/.test(row.reason ?? '')) {
    console.log(`FAIL: ${row.id} (${row.status}) has no Chinese reason: ${row.reason}`);
    process.exitCode = 1;
  }
  if (row.cost && !['auto', 'auto-tier', 'estimate', 'ver-estimate', 'fam-estimate', 'alias', 'manual'].includes(row.status)) {
    console.log(`FAIL: ${row.id} carries a price under status ${row.status}`);
    process.exitCode = 1;
  }
}

// Fallback ladder — the three steps the user asked for must actually fire on a
// name the book does not list, and must stay labelled as an estimate.
const ladderCases = [
  ['kimi-k2.9-preview', 'pending'],        // sub-version the book never listed -> ask, do not guess
  ['glm-9.9-flash', 'fam-estimate'],       // version+tier missing entirely -> closest version
  ['totally-unknown-thing', 'none'],       // no known family -> no price at all
  ['hy4std', 'none'],                      // family known but no version -> refuse to guess
];
for (const [id, expected] of ladderCases) {
  const res = resolveModel(id, index, {}, {});
  const ok = res.status === expected;
  console.log(`ladder ${id} -> ${res.status}${res.canonical ? ` (${res.canonical})` : ''}${ok ? ' OK' : ` FAIL (want ${expected})`}`);
  if (!ok) process.exitCode = 1;
  if (!/[一-龥]/.test(res.reason ?? '')) { console.log(`  note: reason not Chinese: ${res.reason}`); process.exitCode = 1; }
}

const pending = rows.filter((r) => r.status === 'pending');
if (pending.length > 0) {
  console.log(`\n${pending.length} model(s) need one click in the panel: ${pending.map((r) => r.id).join(', ')}`);
}

// --- injection shape -------------------------------------------------------
const { augmentBook, writeStore } = plugin.__test;
const before = JSON.stringify(book.agent2api ?? null);
const { merged, report, discovery: disc2 } = augmentBook(book);
const section = merged.agent2api?.models ?? {};
const pricedCount = rows.filter((r) => r.cost).length;
console.log('');
console.log(`inject: provider agent2api has ${Object.keys(section).length} priced models (expected ${pricedCount}); report=${JSON.stringify({
  auto: report.auto.length, tier: report.tier.length, estimate: report.estimate.length,
  verEst: report.verEst.length, famEst: report.famEst.length, none: report.none.length,
})}`);
if (Object.keys(section).length !== pricedCount) { console.log('FAIL: injected model count mismatch'); process.exitCode = 1; }
if (JSON.stringify(book.agent2api ?? null) !== before) { console.log('FAIL: pristine book was mutated'); process.exitCode = 1; }
const anchorSection = section['kimi-k3-1'];
console.log(`inject: kimi-k3-1 -> ${anchorSection ? `${anchorSection.cost.input}/${anchorSection.cost.output}` : 'MISSING'}`);
if (!anchorSection) { console.log('FAIL: kimi-k3-1 was not injected'); process.exitCode = 1; }
// A 0/0 the user typed by hand ("this one is free") is intentional; a 0/0 that
// came out of a match is a bug.
const manualIds = new Set(rows.filter((r) => r.status === 'manual').map((r) => r.id));
const badZero = Object.entries(section).filter(([id, v]) => !manualIds.has(id) && v.cost.input === 0 && v.cost.output === 0);
if (badZero.length > 0) { console.log(`FAIL: 0/0 injected for ${badZero.map(([k]) => k).join(', ')}`); process.exitCode = 1; }

// --- alias round-trip ------------------------------------------------------
const store = readStore();
const backup = JSON.stringify(store);
writeStore({ overrides: store.overrides, aliases: { ...store.aliases, 'deepseek-v4.1-flash': 'deepseek/deepseek-v4-flash' } });
const aliased = resolveModel('deepseek-v4.1-flash', index, readStore().aliases, readStore().overrides);
console.log(`alias: deepseek-v4.1-flash -> ${aliased.canonical} (${aliased.status}) in=${aliased.cost?.input}`);
if (aliased.status !== 'alias' || aliased.cost?.input !== 0.15) { console.log('FAIL: alias was not applied'); process.exitCode = 1; }
writeStore(JSON.parse(backup)); // restore whatever was there
console.log(`alias: config restored (${plugin.__test.CONFIG_PATH})`);
console.log(process.exitCode ? 'RESULT: FAILURES ABOVE' : 'RESULT: ALL CHECKS PASSED');
