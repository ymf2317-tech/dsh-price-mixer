/**
 * dsh-price-mixer — host half.
 *
 * Transparently augments the models.dev price book that dsh-context fetches,
 * so locally proxied models get a reference price in the Context panel's
 * Est. Cost card.
 *
 * How: on host start, wrap globalThis.fetch with a shell that matches exactly
 * one URL — https://models.dev/api.json — fetch the real book upstream,
 * inject one provider section per *configured* provider, return the merged
 * JSON. Every other request passes through untouched. If anything in the
 * augment path throws, the shell falls back to the pristine upstream response,
 * so the worst case is "no custom prices" — never a broken price book.
 *
 * Where the model list comes from (0.3.0): the DSH profile's cordis.patch.yml,
 * i.e. `providers.<name>.models[].id`. That is the list DSH actually loads, it
 * needs no API key, and it costs no request to the gateway. Nothing here talks
 * to /v1/models. The only network call this plugin ever makes is the public
 * models.dev JSON.
 *
 * How a name is matched (0.3.0): every model id — ours and every book entry —
 * is split into four slots (family / version / tier / qualifiers), then scored:
 *
 *   family equal                     required (hard filter)
 *   version equal                    +42
 *   candidate version is a coarser   +16   ("v4.1" vs "v4")
 *     prefix of ours
 *   both sides have no version       +12
 *   tier equal                       +34
 *   both sides have no tier          +24
 *   query has a tier, book is base    +6
 *   identical leaf name             +25
 *   official vendor of that family    +8
 *   shared qualifier token       +6 each (max 12)
 *   unmatched qualifier          -6 each (max -18, gateway noise ignored)
 *
 *   >= 88 and the runner-up is >=12 behind  -> auto (injected)
 *   60..87, or a close/ambiguous top group -> pending, top 3 candidates shown
 *   < 60                                    -> unpriced
 *
 * A pending model injects nothing: guessing a wrong price silently is exactly
 * what this design refuses to do. One click in the panel (or one POST) records
 * an alias, and aliases are replayed before any fuzzy scoring.
 *
 * Config file (created on first save from the panel):
 *   %USERPROFILE%/.dsh/price-mixer.json
 *   { "overrides": { "glm-5.3-max": { "input": 1.2, "output": 4.2 } },
 *     "aliases":   { "kimi-k3-1": "moonshotai/kimi-k3.1" } }
 *   delete a key to return that model to automatic matching.
 *
 * Routes (mounted on the web server while this plugin is active):
 *   GET  /price-mixer/status    shell state, discovery, injection report, log
 *   GET  /price-mixer/models    every configured model + price + candidates
 *   POST /price-mixer/reload    re-read the price book
 *   POST /price-mixer/override  { model, input, output, cache_read, cache_write }
 *   POST /price-mixer/reset     { model } | { all: true }
 *   POST /price-mixer/alias     { model, canonical } | { model, canonical: null }
 *
 * Rollback: remove the `dsh-price-mixer` row from cordis.patch.yml and the
 * `file:vendor/dsh-price-mixer` dependency from package.json, restart dsh.
 * The fetch shell dies with the process; nothing on disk is patched.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const BOOK_URL = 'https://models.dev/api.json';
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const PROFILES_DIR = join(DSH_HOME, 'profiles');
const CONFIG_PATH = process.env.DSH_PRICE_MIXER_CONFIG || join(DSH_HOME, 'price-mixer.json');

// Compile-in overrides (USD per 1M tokens). Lowest priority: the config file
// wins, so the panel can always override what is written here.
// NOTE: dsh-context bills DeepSeek-family providers at 2x during Beijing peak
// hours (the book lists off-peak rates); everything else uses the rate as-is.
const OVERRIDE = {
  // 'model-id': { input: 1, output: 2, cache_read: 0.1, cache_write: 2 },
};

// Used only when config discovery finds no provider at all (a profile that
// stores its models somewhere unexpected). Keeps the plugin useful instead of
// silently pricing nothing — the log says loudly when this path is taken.
const FALLBACK_PROVIDERS = [{
  name: 'agent2api',
  models: [
    'Doubao-Seed-2.1-Pro-max', 'Doubao-Seed-Evolving-max',
    'glm-5.3-flash-max', 'glm-5.3-flashx-max', 'glm-5.3-max',
    'deepseek-v4.1-flash-max', 'DeepSeek-V4-Pro-Official-max',
    'kimi-k3.1-pro-max', 'kimi-k3-max',
    'mimo-v2.6-flash-max', 'mimo-v2.6-pro-max',
    'minimax-m3.1-flash-max', 'minimax-m3-max',
    'step-5-preview-max', 'step-5-preview',
    'qwen3.8-flash-max', 'qwen3.8-max-max', 'minimax-m3.1-flash',
    'glm-5.3', 'glm-5.3-flash', 'glm-5.2',
    'kimi-k3-1', 'kimi-k2.8-preview',
    'deepseek-v4.1-flash', 'deepseek-v4-pro',
    'mimo-v2.6-pro', 'kimi-k3.1-pro',
  ],
}];

const STATE = {
  installed: false,
  wrappedFetches: 0,
  injections: 0,
  lastInjection: null, // { at, auto, alias, manual, pending, none }
  lastModels: null,    // [{ id, provider, status, ... }]
  rawBook: null,       // last pristine book object (recompute without refetch)
  lastBooks: 0,        // providers in the last pristine book seen
  lastError: null,
  log: [],
  storeCache: { at: 0, mtimeMs: -1, store: { overrides: {}, aliases: {} } },
  book: { at: 0, providers: 0, error: null, loading: null },
  discovery: null,     // { at, files: [...], providers: [...], error }
};

// The native fetch, captured before the shell replaces globalThis.fetch, so the
// plugin's own book loads never re-enter the shell.
const NATIVE_FETCH = typeof globalThis.fetch === 'function' ? globalThis.fetch : null;

function logLine(kind, message) {
  const entry = { at: Date.now(), kind, message };
  STATE.log.push(entry);
  if (STATE.log.length > 200) STATE.log.splice(0, STATE.log.length - 200);
  try { console.log(`[dsh-price-mixer] ${kind}: ${message}`); } catch {}
}

/* ---------------------------------------------------------------- config */

function readStore() {
  // Re-read whenever the file changes; the panel writes it, the shell reads it
  // on the next book fetch, so a save lands without a restart.
  let mtimeMs = -1;
  try { mtimeMs = existsSync(CONFIG_PATH) ? statSync(CONFIG_PATH).mtimeMs : -1; } catch {}
  if (STATE.storeCache.mtimeMs === mtimeMs && Date.now() - STATE.storeCache.at < 1000) {
    return STATE.storeCache.store;
  }
  const overrides = {};
  const aliases = {};
  if (mtimeMs >= 0) {
    try {
      const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        const raw = parsed.overrides;
        if (raw && typeof raw === 'object') {
          for (const [id, value] of Object.entries(raw)) {
            const clean = cleanCost(value);
            if (clean) overrides[id] = clean;
          }
        }
        const rawAlias = parsed.aliases;
        if (rawAlias && typeof rawAlias === 'object') {
          for (const [id, value] of Object.entries(rawAlias)) {
            if (value === null) aliases[id] = null;          // explicit "no price"
            else if (typeof value === 'string' && value.trim()) aliases[id] = value.trim();
          }
        }
      }
    } catch (error) {
      logLine('warn', `config file unreadable, falling back to automatic matching: ${String(error && error.message || error)}`);
    }
  }
  const store = { overrides, aliases };
  STATE.storeCache = { at: Date.now(), mtimeMs, store };
  return store;
}

function writeStore(store) {
  const body = JSON.stringify({
    overrides: store.overrides ?? {},
    aliases: store.aliases ?? {},
  }, null, 2) + '\n';
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const tmp = CONFIG_PATH + '.tmp';
  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, CONFIG_PATH); // atomic-ish replace; a crash never leaves half a file
  STATE.storeCache = { at: 0, mtimeMs: -1, store: { overrides: {}, aliases: {} } };
}

function readConfig() { return readStore().overrides; }
function readAliases() { return readStore().aliases; }

function cleanCost(value) {
  if (!value || typeof value !== 'object') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  const input = num(value.input);
  const output = num(value.output);
  if (input === undefined || output === undefined) return null;
  return {
    input,
    output,
    cache_read: num(value.cache_read) ?? input,
    cache_write: num(value.cache_write) ?? input,
  };
}

/* ------------------------------------------------------------- discovery */

function profileFromArgv(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--profile' && argv[i + 1]) return argv[i + 1];
    const m = /^--profile=(.+)$/.exec(arg || '');
    if (m) return m[1];
  }
  return process.env.DSH_PROFILE || null;
}

function profileDirs() {
  try {
    return readdirSync(PROFILES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch { return []; }
}

function fileInfo(path) {
  let mtimeMs = -1;
  try { mtimeMs = existsSync(path) ? statSync(path).mtimeMs : -1; } catch { mtimeMs = -1; }
  return { path, mtimeMs };
}

// Which patch files describe this host's providers. Order matters: the profile
// layer first, then the home-wide user layer (which may add providers too).
function sourceFiles() {
  const explicit = (process.env.DSH_PRICE_MIXER_SOURCES || '')
    .split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  if (explicit.length) return explicit.map(fileInfo);

  const files = [];
  const seen = new Set();
  const push = (info) => { if (!info.path || seen.has(info.path)) return; seen.add(info.path); files.push(info); };

  let profile = profileFromArgv(process.argv);
  if (!profile) {
    // `dsh web` style boots pass the profile as a positional argument.
    const dirs = profileDirs();
    for (const arg of process.argv.slice(2)) {
      const bare = arg.replace(/^-+/, '');
      if (dirs.includes(bare)) { profile = bare; break; }
    }
  }
  if (profile) push(fileInfo(join(PROFILES_DIR, profile, 'cordis.patch.yml')));
  push(fileInfo(join(DSH_HOME, 'cordis.patch.yml')));

  // No profile on argv: read every profile layer, keep the ones that actually
  // declare providers, newest first. (A host normally boots one profile, so
  // this only matters when argv was rewritten before we loaded.)
  if (!profile) {
    const candidates = profileDirs()
      .map((name) => fileInfo(join(PROFILES_DIR, name, 'cordis.patch.yml')))
      .filter((info) => info.mtimeMs >= 0)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const info of candidates) push(info);
  }
  return files;
}

// Minimal YAML reader for exactly one shape: providers.<name>.models[].id.
// It never touches anything outside a `providers:` block, so unrelated `id:`
// keys elsewhere in the patch file cannot leak in.
function parseProviderModels(text) {
  const out = new Map(); // provider -> [ids]
  const lines = String(text).split(/\r?\n/);
  const indentOf = (line) => line.length - line.replace(/^[ \t]+/, '').length;
  let inProviders = false;
  let providersIndent = -1;
  let providerIndent = -1;
  let current = null;
  let inModels = false;
  let modelsIndent = -1;

  const closeModels = () => { inModels = false; modelsIndent = -1; };
  const closeProvider = () => { current = null; providerIndent = -1; closeModels(); };
  const add = (id) => {
    const clean = String(id).trim().replace(/^['"]|['"]$/g, '');
    if (!clean || !current) return;
    if (!out.has(current)) out.set(current, []);
    const list = out.get(current);
    if (!list.includes(clean)) list.push(clean);
  };

  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = indentOf(raw);
    const line = raw.trim();

    if (/^providers:\s*$/.test(line)) {
      inProviders = true;
      providersIndent = indent;
      providerIndent = -1;
      current = null;
      closeModels();
      continue;
    }
    if (!inProviders) continue;
    if (indent <= providersIndent) { inProviders = false; closeProvider(); continue; }

    const keyOnly = /^([A-Za-z0-9_.\-]+):\s*(?:#.*)?$/.exec(line);
    if (keyOnly) {
      if (providerIndent < 0) providerIndent = indent;
      if (indent === providerIndent) {
        current = keyOnly[1];
        if (!out.has(current)) out.set(current, []);
        closeModels();
        continue;
      }
      if (!current) continue;
      if (inModels && indent <= modelsIndent) closeModels();
      if (keyOnly[1] === 'models' && !inModels) { inModels = true; modelsIndent = indent; continue; }
      // mapping form: providers.p.models.<model-id>: {...}
      if (inModels && indent === modelsIndent + 2) add(keyOnly[1]);
      continue;
    }

    if (!current || !inModels) continue;
    if (indent <= modelsIndent) { closeModels(); continue; }
    const idMatch = /\bid:\s*(['"]?)([^'"\s,}]+)\1/.exec(line);
    if (idMatch) add(idMatch[2]);
  }

  return out;
}

function discoverModels(force = false) {
  const files = sourceFiles();
  const signature = files.map((info) => `${info.path}@${info.mtimeMs}`).join('|');
  if (!force && STATE.discovery && STATE.discovery.signature === signature) return STATE.discovery;

  const scanned = [];
  const merged = new Map();
  for (const info of files) {
    const entry = { path: info.path, exists: info.mtimeMs >= 0, providers: 0, models: 0, error: null };
    if (!entry.exists) { scanned.push(entry); continue; }
    try {
      const map = parseProviderModels(readFileSync(info.path, 'utf8'));
      entry.providers = map.size;
      let count = 0;
      for (const [name, ids] of map) {
        if (ids.length === 0) continue;
        count += ids.length;
        if (!merged.has(name)) merged.set(name, []);
        const list = merged.get(name);
        for (const id of ids) if (!list.includes(id)) list.push(id);
      }
      entry.models = count;
    } catch (error) {
      entry.error = String((error && error.message) || error);
    }
    scanned.push(entry);
  }

  let providers = [...merged.entries()].map(([name, models]) => ({ name, models }));
  let fallback = false;
  if (providers.length === 0) {
    providers = FALLBACK_PROVIDERS.map((p) => ({ name: p.name, models: [...p.models] }));
    fallback = true;
  }

  const total = providers.reduce((sum, p) => sum + p.models.length, 0);
  const discovery = {
    at: Date.now(),
    signature,
    files: scanned,
    providers,
    fallback,
    total,
    error: scanned.every((f) => f.error) && scanned.length > 0
      ? scanned.map((f) => f.error).filter(Boolean).join('; ')
      : null,
  };
  STATE.discovery = discovery;
  if (fallback) logLine('warn', 'no configured providers found; using the built-in fallback list (models may be stale)');
  else logLine('info', `discovered ${total} models in ${providers.length} provider(s) from ${scanned.filter((f) => f.exists).length} config file(s)`);
  return discovery;
}

/* ------------------------------------------------------------ name parse */

const VERSION_MARKERS = new Set(['v', 'ver', 'version', 'k', 'm', 'r', 'h']);
const TIER_WORDS = new Set([
  'max', 'pro', 'flashx', 'flash', 'preview', 'highspeed', 'turbo', 'plus', 'ultra',
  'mini', 'lite', 'air', 'nano', 'thinking', 'reasoning', 'coder', 'vision',
  'instruct', 'chat', 'omni', 'realtime', 'base', 'large', 'small', 'medium',
]);
// Gateway artifacts that decorate a model name without meaning anything to the
// price book. Matched but missing on the other side is not a penalty.
const GATEWAY_NOISE = new Set(['max', 'official', 'latest', 'exp', 'experimental', 'std', 'free', 'vip', 'new', 'api', 'cn', 'intl']);
// Book provider that officially owns a family; a quote from there is preferred.
const OFFICIAL_PROVIDER = {
  deepseek: 'deepseek', kimi: 'moonshotai', glm: 'zhipuai', qwen: 'alibaba',
  step: 'stepfun', mimo: 'xiaomi', minimax: 'minimax', doubao: 'volcengine',
  gemini: 'google', claude: 'anthropic', gpt: 'openai', llama: 'meta',
};

const PARSE_CACHE = new Map();

function tokensOf(id) {
  const base = String(id || '').trim().toLowerCase();
  // drop a namespace prefix such as "cn:" or "vendor/"
  const cleaned = base.replace(/^[a-z0-9_.\-]+[:/]/, '');
  const parts = cleaned.split(/[\s_\-]+/).filter(Boolean);
  const tokens = [];
  for (const part of parts) {
    const alphaFirst = /^([a-z]+)(\d.*)$/.exec(part);
    if (alphaFirst) { tokens.push(alphaFirst[1]); tokens.push(alphaFirst[2]); continue; }
    const digitFirst = /^(\d+(?:\.\d+)*)([a-z].*)$/.exec(part);
    if (digitFirst) { tokens.push(digitFirst[1]); tokens.push(digitFirst[2]); continue; }
    tokens.push(part);
  }
  return tokens;
}

function parseModelId(id) {
  const key = String(id ?? '');
  const hit = PARSE_CACHE.get(key);
  if (hit) return hit;
  const tokens = tokensOf(key);
  const isNum = (t) => /^\d+(?:\.\d+)*$/.test(t);

  let family = null;
  let start = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (isNum(t) || VERSION_MARKERS.has(t) || TIER_WORDS.has(t) || GATEWAY_NOISE.has(t)) continue;
    family = t;
    start = i + 1;
    break;
  }

  let version = null;
  const tiers = [];
  const quals = [];
  const rest = tokens.slice(start);
  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i];
    if (VERSION_MARKERS.has(t) && isNum(rest[i + 1] || '')) continue; // "v4", "k3"
    if (isNum(t)) {
      let v = t;
      // "kimi-k3-1" / "doubao-seed-1-8-251228": a short integer right after the
      // first number group is a minor version written with a dash — but only
      // when nothing meaningful follows it. "qwen3-8b" is qwen3 (8B), not 3.8.
      while (
        i + 1 < rest.length && /^\d{1,2}$/.test(rest[i + 1]) &&
        Number(rest[i + 1]) < 32 && !v.includes('.') &&
        (
          i + 2 >= rest.length ||
          TIER_WORDS.has(rest[i + 2]) ||
          GATEWAY_NOISE.has(rest[i + 2]) ||
          /^\d{4,}$/.test(rest[i + 2])
        )
      ) { v = `${v}.${rest[i + 1]}`; i += 1; }
      if (version === null) version = v;
      else quals.push(v); // a second number group is a date/step qualifier
      continue;
    }
    if (TIER_WORDS.has(t)) { tiers.push(t); continue; }
    if (GATEWAY_NOISE.has(t)) { quals.push(t); continue; }
    quals.push(t);
  }

  const parsed = {
    raw: key,
    leaf: key.split('/').pop().toLowerCase(),
    family,
    version,
    tier: tiers[0] ?? null,
    tiers,
    quals,
    extras: [...tiers.slice(1), ...quals],
  };
  PARSE_CACHE.set(key, parsed);
  return parsed;
}

/* ------------------------------------------------------------- matching */

// Providers whose "price" is a subscription plan, not a per-token rate: their
// entries are listed at 0 and must never win a match.
const PLAN_PROVIDER = /(?:^|[-_/])(?:coding-plan|token-plan|free)(?:$|[-_/])/i;

function isPlanProvider(name) {
  return PLAN_PROVIDER.test(String(name));
}

function buildBookIndex(book) {
  const byFamily = new Map();
  let total = 0;
  let skipped = 0;
  for (const [provider, entry] of Object.entries(book ?? {})) {
    const models = entry && typeof entry === 'object' ? entry.models : null;
    if (!models || typeof models !== 'object') continue;
    if (isPlanProvider(provider)) { skipped += Object.keys(models).length; continue; }
    for (const [key, value] of Object.entries(models)) {
      const cost = value && value.cost;
      if (!cost || typeof cost.input !== 'number' || typeof cost.output !== 'number') { skipped += 1; continue; }
      // 0/0 is a plan inclusion, not a price
      if (cost.input === 0 && cost.output === 0) { skipped += 1; continue; }
      const parsed = parseModelId(key);
      if (!parsed.family) { skipped += 1; continue; }
      total += 1;
      if (!byFamily.has(parsed.family)) byFamily.set(parsed.family, []);
      byFamily.get(parsed.family).push({ provider, key, canonical: `${provider}/${key}`, cost, parsed });
    }
  }
  return { byFamily, total, skipped };
}

// "max" is a gateway suffix, not a real tier: normalize it away so
// "glm-5.3-max" compares as base glm-5.3 (and "qwen3.8-max-max" too).
function normalizeTier(tier) {
  return tier === 'max' ? null : (tier ?? null);
}

function scorePair(query, candidate) {
  if (!query.family || !candidate.family || query.family !== candidate.family) return null;
  let score = 40;
  const reasons = [`family:${query.family}`];

  if (query.version && candidate.version) {
    if (query.version === candidate.version) { score += 42; reasons.push(`version:${query.version}`); }
    else if (query.version.startsWith(`${candidate.version}.`)) { score += 16; reasons.push(`version~${candidate.version}`); }
    else if (candidate.version.startsWith(`${query.version}.`)) { score += 0; reasons.push(`version<${candidate.version}`); }
    else return null;
  } else if (!query.version && !candidate.version) { score += 12; }
  else { score += 8; }

  // "max" is a gateway suffix, not a real tier: normalize it away so
  // "glm-5.3-max" compares as base glm-5.3 (and "qwen3.8-max-max" too).
  const queryTier = normalizeTier(query.tier);
  const candidateTier = normalizeTier(candidate.tier);
  if (queryTier && candidateTier) {
    if (queryTier === candidateTier) { score += 34; reasons.push(`tier:${queryTier}`); }
    else return null;
  } else if (!queryTier && !candidateTier) { score += 24; }
  else if (queryTier && !candidateTier) { score += 6; reasons.push(`tier:${queryTier}->base`); }
  else { score += 4; }

  const queryExtras = new Set(query.extras ?? []);
  const candidateExtras = new Set(candidate.extras ?? []);
  let shared = 0;
  for (const token of queryExtras) if (candidateExtras.has(token)) shared += 1;
  if (shared > 0) { score += Math.min(12, shared * 6); reasons.push(`shared:${shared}`); }
  let missing = 0;
  for (const token of queryExtras) if (!candidateExtras.has(token) && !GATEWAY_NOISE.has(token)) missing += 1;
  if (missing > 0) { score -= Math.min(18, missing * 6); reasons.push(`unmatched:${missing}`); }

  // A match needs at least one real anchor — an identical leaf name, an equal
  // (or prefix-related) version, or a shared qualifier. Two unrelated names
  // that merely share a family must never pass for a match.
  const versionRelated = !!(query.version && candidate.version) && (
    query.version === candidate.version ||
    query.version.startsWith(`${candidate.version}.`) ||
    candidate.version.startsWith(`${query.version}.`)
  );
  if (shared === 0 && query.leaf !== candidate.leaf && !versionRelated) return null;

  if (query.leaf === candidate.leaf) { score += 25; reasons.push('name:exact'); }

  const official = OFFICIAL_PROVIDER[query.family];
  if (official && String(candidate.provider).toLowerCase().includes(official)) {
    score += 8;
    reasons.push('vendor:official');
  }

  return { score, reasons };
}

const AUTO_MIN = 88;
const PENDING_MIN = 60;
const WIN_MARGIN = 12;
// statuses that carry a price into the book
const PRICED_STATUSES = new Set(['auto', 'auto-tier', 'estimate']);

function median(values) {
  const list = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (list.length === 0) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

function candidateView(hit, score, reasons) {
  return {
    canonical: hit.canonical,
    provider: hit.provider,
    score: Math.round(score * 10) / 10,
    input: hit.cost.input,
    output: hit.cost.output,
    cache_read: typeof hit.cost.cache_read === 'number' ? hit.cost.cache_read : hit.cost.input,
    reasons,
  };
}

// Pick one quote out of a top-scoring group. The book resells almost every
// model through dozens of gateways at slightly different prices, so "all
// providers must agree" would reject nearly everything. Priority instead:
//   1. the vendor that owns the family (zhipuai for glm, moonshotai for kimi…);
//   2. that price when everyone agrees;
//   3. otherwise the most frequently quoted price — flagged as an estimate.
function settleGroup(group) {
  if (group.length === 0) return { hit: null, kind: 'none', spread: 0 };
  const priceKey = (item) => `${item.hit.cost.input}/${item.hit.cost.output}`;
  const tally = (items) => {
    const counts = new Map();
    for (const item of items) {
      const key = priceKey(item);
      if (!counts.has(key)) counts.set(key, { count: 0, item });
      counts.get(key).count += 1;
    }
    return [...counts.values()].sort(
      (a, b) => b.count - a.count ||
        // prefer the shorter provider id: "moonshotai" over "moonshotai-cn",
        // "stepfun" over "stepfun-ai" — the plain global section
        String(a.item.provider).length - String(b.item.provider).length ||
        a.item.hit.cost.input - b.item.hit.cost.input ||
        String(a.item.hit.canonical).localeCompare(String(b.item.hit.canonical)),
    );
  };

  const officials = group.filter((item) => item.official);
  if (officials.length > 0) {
    const ranked = tally(officials);
    return { hit: ranked[0].item.hit, kind: 'official', spread: ranked.length };
  }
  const ranked = tally(group);
  return { hit: ranked[0].item.hit, kind: ranked.length === 1 ? 'unanimous' : 'modal', spread: ranked.length };
}

function matchModel(modelId, index) {
  const query = parseModelId(modelId);
  if (!query.family) return { query, status: 'none', candidates: [], reason: 'no family token' };
  const pool = index.byFamily.get(query.family) ?? [];
  if (pool.length === 0) return { query, status: 'none', candidates: [], reason: `no "${query.family}" entries in the book` };

  const official = OFFICIAL_PROVIDER[query.family];
  const scored = [];
  for (const hit of pool) {
    const result = scorePair(query, hit.parsed);
    if (!result) continue;
    scored.push({
      hit,
      score: result.score,
      reasons: result.reasons,
      official: !!(official && String(hit.provider).toLowerCase().includes(official)),
    });
  }
  if (scored.length === 0) {
    return { query, status: 'none', candidates: [], reason: 'every name in this family conflicts on version or tier' };
  }
  scored.sort((a, b) => b.score - a.score || String(a.hit.canonical).localeCompare(String(b.hit.canonical)));

  // Collapse equal scores into groups so a 60-provider tie counts as one answer.
  const groups = [];
  for (const item of scored) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last.score - item.score) < 0.0001) last.items.push(item);
    else groups.push({ score: item.score, items: [item] });
  }
  const top = groups[0];
  const runnerUp = groups[1] ? groups[1].score : -Infinity;
  const settled = settleGroup(top.items);
  const candidates = scored.slice(0, 3).map((item) => candidateView(item.hit, item.score, item.reasons));
  const priced = settled.kind === 'official' || settled.kind === 'unanimous' ? 'auto' : 'estimate';

  // Version is decisive. A query that names a version the book only ships with
  // a tier ("kimi-k3-1" -> k3.1 exists only as k3.1-pro) adopts that tier
  // instead of falling back to a different version.
  if (!query.tier && top.score >= AUTO_MIN - 8) {
    const sameVersion = scored.filter((item) => item.hit.parsed.version === query.version);
    const tierless = sameVersion.some((item) => !item.hit.parsed.tier);
    const tiers = new Set(sameVersion.map((item) => item.hit.parsed.tier).filter(Boolean));
    if (!tierless && sameVersion.length > 0 && tiers.size === 1) {
      const best = sameVersion.find((item) => item.official) ?? sameVersion[0];
      return {
        query, status: 'auto-tier', candidates,
        hit: best.hit, score: Math.round(best.score * 10) / 10,
        reason: `no base entry for version ${query.version}; priced as its only tier "${[...tiers][0]}"`,
      };
    }
  }

  if (top.score >= AUTO_MIN && top.score - runnerUp >= WIN_MARGIN) {
    return {
      query, status: priced, candidates,
      hit: settled.hit, score: Math.round(top.score * 10) / 10,
      reason: `${priced}: ${top.score.toFixed(0)} vs runner-up ${runnerUp === -Infinity ? 'none' : runnerUp.toFixed(0)}` +
        (priced === 'estimate' ? ` (${settled.spread} gateways disagree; most common price)` : ''),
    };
  }
  if (top.score >= PENDING_MIN) {
    return {
      query, status: 'pending', candidates,
      score: Math.round(top.score * 10) / 10,
      reason: top.score - runnerUp < WIN_MARGIN && runnerUp !== -Infinity
        ? `top two are ${(top.score - runnerUp).toFixed(0)} apart — confirm one`
        : `best score ${top.score.toFixed(0)} < ${AUTO_MIN}`,
    };
  }
  return { query, status: 'none', candidates, reason: `best score ${top.score.toFixed(0)} < ${PENDING_MIN}` };
}

function resolveModel(modelId, index, aliases, overrides) {
  const manual = cleanCost(overrides[modelId]) ?? cleanCost(OVERRIDE[modelId]);
  if (manual) return { id: modelId, status: 'manual', cost: manual, canonical: null, candidates: [] };

  if (Object.prototype.hasOwnProperty.call(aliases, modelId)) {
    const canonical = aliases[modelId];
    if (canonical === null) return { id: modelId, status: 'alias-none', cost: null, canonical: null, candidates: [] };
    const slash = canonical.indexOf('/');
    if (slash > 0) {
      const provider = canonical.slice(0, slash);
      const key = canonical.slice(slash + 1);
      const entry = index.byFamily.get(parseModelId(key).family) ?? [];
      const hit = entry.find((item) => item.provider === provider && item.key === key);
      if (hit) {
        return {
          id: modelId, status: 'alias', cost: hit.cost, canonical, candidates: [],
          reason: 'alias from config',
        };
      }
      return {
        id: modelId, status: 'alias-stale', cost: null, canonical, candidates: [],
        reason: `${canonical} is not in the current price book`,
      };
    }
    return { id: modelId, status: 'alias-stale', cost: null, canonical, candidates: [], reason: 'alias is not "provider/model"' };
  }

  const match = matchModel(modelId, index);
  const base = { id: modelId, query: match.query, candidates: match.candidates, score: match.score ?? null, reason: match.reason };
  if (PRICED_STATUSES.has(match.status) && match.hit) {
    return { ...base, status: match.status, cost: match.hit.cost, canonical: match.hit.canonical };
  }
  return { ...base, status: match.status === 'pending' ? 'pending' : 'none', cost: null, canonical: null };
}

// A quote that sits wildly outside its own family+tier price band is more
// likely a bad match than a bargain — demote it to pending instead of injecting
// it. The comparison is per tier on purpose: a "flash" model is legitimately an
// order of magnitude cheaper than the "pro" of the same family.
function priceBandKey(row) {
  const family = row.query?.family;
  if (!family) return null;
  return `${family}|${normalizeTier(row.query?.tier) ?? '-'}`;
}

function applyPriceGuard(rows) {
  const trusted = new Map();
  for (const row of rows) {
    if (!row.cost) continue;
    if (!(PRICED_STATUSES.has(row.status) || row.status === 'alias' || row.status === 'manual')) continue;
    const key = priceBandKey(row);
    if (!key) continue;
    if (!trusted.has(key)) trusted.set(key, []);
    trusted.get(key).push(row.cost.input);
  }
  for (const row of rows) {
    if (row.status !== 'auto' && row.status !== 'auto-tier') continue;
    const key = priceBandKey(row);
    const band = key ? trusted.get(key) : null;
    if (!band || band.length < 2) continue;
    const mid = median(band);
    if (!mid) continue;
    if (row.cost.input > mid * 4 || row.cost.input < mid / 4) {
      row.status = 'pending';
      row.reason = `${row.reason}; price ${row.cost.input} is far outside the ${key} band (median ${mid})`;
      row.suspect = true;
      row.cost = null;
    }
  }
  return rows;
}

function resolveAll(index, discovery) {
  const { overrides, aliases } = readStore();
  const rows = [];
  for (const provider of discovery.providers) {
    for (const id of provider.models) {
      const resolved = resolveModel(id, index, aliases, overrides);
      rows.push({ ...resolved, provider: provider.name });
    }
  }
  return applyPriceGuard(rows);
}

/* ---------------------------------------------------------------- shell */

function augmentBook(book) {
  const discovery = discoverModels();
  const index = buildBookIndex(book);
  const rows = resolveAll(index, discovery);

  const report = { auto: [], tier: [], estimate: [], alias: [], manual: [], pending: [], none: [], stale: [] };
  const merged = { ...book };
  const byProvider = new Map();

  for (const row of rows) {
    if (row.status === 'auto') report.auto.push(row.id);
    else if (row.status === 'auto-tier') report.tier.push(row.id);
    else if (row.status === 'estimate') report.estimate.push(row.id);
    else if (row.status === 'alias') report.alias.push(row.id);
    else if (row.status === 'manual') report.manual.push(row.id);
    else if (row.status === 'alias-stale') report.stale.push(row.id);
    else if (row.status === 'alias-none') continue;
    else if (row.status === 'pending') report.pending.push(row.id);
    else report.none.push(row.id);

    if (!row.cost) continue;
    if (!byProvider.has(row.provider)) byProvider.set(row.provider, {});
    byProvider.get(row.provider)[row.id] = {
      cost: {
        input: row.cost.input,
        output: row.cost.output,
        cache_read: row.cost.cache_read,
        cache_write: row.cost.cache_write,
      },
    };
  }

  let collision = false;
  for (const [provider, section] of byProvider) {
    const existing = merged[provider];
    if (existing && typeof existing === 'object') {
      // A real book provider with the same name: keep its own quotes for the
      // models it already prices, add ours for the rest.
      merged[provider] = { ...existing, models: { ...section, ...(existing.models ?? {}) } };
      collision = true;
    } else {
      merged[provider] = { name: `${provider} (configured)`, models: section };
    }
  }

  STATE.lastModels = rows;
  STATE.rawBook = book; // kept so a panel click can recompute without a refetch
  STATE.lastBooks = Object.keys(book ?? {}).length;
  return {
    merged,
    report,
    discovery,
    collision,
    priced: report.auto.length + report.tier.length + report.estimate.length + report.alias.length + report.manual.length,
  };
}

function installShell() {
  if (STATE.installed) return;
  const nativeFetch = globalThis.fetch;
  if (typeof nativeFetch !== 'function') {
    logLine('warn', 'globalThis.fetch is not a function; shell not installed');
    return;
  }
  STATE.installed = true;
  const shell = async (input, init) => {
    const url = typeof input === 'string' ? input : input && input.url ? input.url : '';
    if (url !== BOOK_URL) return nativeFetch(input, init);
    STATE.wrappedFetches += 1;
    let response;
    try {
      response = await nativeFetch(input, init);
    } catch (error) {
      STATE.lastError = String((error && error.message) || error);
      logLine('warn', `upstream fetch failed, passing the error through: ${STATE.lastError}`);
      throw error;
    }
    try {
      const text = await response.text();
      let book;
      try {
        book = JSON.parse(text);
      } catch {
        logLine('warn', 'upstream body is not JSON; passing through untouched');
        return passthrough(text, response);
      }
      const { merged, report, discovery, priced } = augmentBook(book);
      STATE.injections += 1;
      STATE.lastInjection = {
        at: Date.now(),
        auto: report.auto.length,
        tier: report.tier.length,
        estimate: report.estimate.length,
        alias: report.alias.length,
        manual: report.manual.length,
        pending: report.pending.length,
        none: report.none.length,
        stale: report.stale.length,
        models: discovery.total,
      };
      logLine('info', `injected ${priced} prices of ${discovery.total} configured models (${report.auto.length} exact, ${report.tier.length} tier-adopted, ${report.estimate.length} estimated, ${report.alias.length} alias, ${report.manual.length} manual; ${report.pending.length} need a click, ${report.none.length} unpriced) into a book of ${Object.keys(book).length} providers`);
      return new Response(JSON.stringify(merged), {
        status: response.status,
        statusText: response.statusText,
        headers: cleanHeaders(response.headers),
      });
    } catch (error) {
      // the augment path exploded -> replay the upstream request as-is
      STATE.lastError = String((error && error.message) || error);
      logLine('warn', `augment failed, refetching pristine book: ${STATE.lastError}`);
      try { return await nativeFetch(input, init); } catch { throw error; }
    }
  };
  // keep the shell's identity close to native fetch (callers may check .name)
  Object.defineProperty(shell, 'name', { value: nativeFetch.name || 'fetch' });
  globalThis.fetch = shell;
  logLine('info', `fetch shell installed; watching ${BOOK_URL}`);
}

function passthrough(text, response) {
  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: cleanHeaders(response.headers),
  });
}

function cleanHeaders(headers) {
  const out = new Headers();
  try {
    headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === 'content-length' || lower === 'content-encoding' || lower === 'transfer-encoding') return;
      out.set(key, value);
    });
  } catch {}
  out.set('content-type', 'application/json');
  return out;
}

// Install on module import: the shell is the whole point of the plugin, and it
// must be in place before dsh-context's first book fetch. Doing it here (not in
// apply) means a future change in the plugin lifecycle can never silently
// disarm price injection.
installShell();

/* ---------------------------------------------------------------- routes */

export const inject = ['webServer'];

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readJsonBody(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object') throw new Error('body must be a JSON object');
  return parsed;
}

function discoveryView() {
  const discovery = STATE.discovery;
  if (!discovery) {
    const fresh = discoverModels();
    return summaryOf(fresh);
  }
  return summaryOf(discovery);
}

function summaryOf(discovery) {
  return {
    at: discovery.at,
    fallback: discovery.fallback,
    total: discovery.total,
    error: discovery.error,
    providers: discovery.providers.map((provider) => ({ name: provider.name, models: provider.models.length })),
    files: discovery.files.map((file) => ({
      path: file.path, exists: file.exists, providers: file.providers, models: file.models, error: file.error,
    })),
  };
}

function modelRows() {
  const discovery = discoverModels();
  const rows = STATE.lastModels ?? [];
  if (rows.length === 0) {
    // the book has not been fetched yet: still show configured models, marked
    // as waiting, so a fresh panel is never empty
    return discovery.providers.flatMap((provider) => provider.models.map((id) => ({
      id, provider: provider.name, status: 'waiting', candidates: [],
    })));
  }
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    status: row.status,
    source: row.status,
    canonical: row.canonical ?? null,
    score: row.score ?? null,
    reason: row.reason ?? null,
    candidates: row.candidates ?? [],
    input: row.cost?.input,
    output: row.cost?.output,
    cache_read: row.cost?.cache_read,
    cache_write: row.cost?.cache_write,
  }));
}

// Load the price book for the panel on its own, so the panel never depends on
// dsh-context having fetched it first (that was why a fresh restart showed
// every model as unpriced). Uses the pre-shell native fetch; 1h TTL.
// Non-blocking: kick a background load if the panel has nothing to show, and
// return immediately with whatever rows exist. The book is ~6MB and this
// network stalls mid-body sometimes, so the panel must never wait on it — the
// client polls while `loading` is true.
function ensureBook(force = false) {
  const fresh = STATE.book.at > 0 && STATE.lastModels !== null && Date.now() - STATE.book.at < 3600_000;
  if (!force && fresh) return STATE.lastModels;
  if (STATE.book.loading || typeof NATIVE_FETCH !== 'function') return STATE.lastModels;
  STATE.book.loading = (async () => {
    try {
      const response = await NATIVE_FETCH(BOOK_URL, {
        headers: { accept: 'application/json' },
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(60000) : undefined,
      });
      if (!response || !response.ok) throw new Error(`HTTP ${response ? response.status : 'no response'}`);
      const book = await response.json();
      const { priced, discovery } = augmentBook(book);
      STATE.book = { at: Date.now(), providers: Object.keys(book).length, error: null, loading: null };
      logLine('info', `price book loaded for the panel (${STATE.book.providers} providers, ${priced}/${discovery.total} configured models priced)`);
    } catch (error) {
      STATE.book = { ...STATE.book, error: String((error && error.message) || error), loading: null };
      logLine('warn', `panel book load failed, keeping last known rows: ${STATE.book.error}`);
    }
    return STATE.lastModels;
  })();
  return STATE.lastModels;
}

// Recompute rows against the book already in hand (no network), so a panel
// click takes effect immediately. If no book has been seen yet, kick a load and
// answer with what we have.
function recompute() {
  const discovery = discoverModels(true);
  if (!STATE.rawBook) {
    ensureBook(true);
    return modelRows();
  }
  const index = buildBookIndex(STATE.rawBook);
  const rows = resolveAll(index, discovery);
  STATE.lastModels = rows;
  return modelRows();
}

export function apply(ctx) {
  const { webServer } = ctx;
  if (!webServer || typeof webServer.register !== 'function') {
    logLine('warn', 'webServer.register unavailable; shell is still active, panel/API not mounted');
    return;
  }

  const mount = (label, path, handler) => {
    try {
      const dispose = webServer.register({ kind: 'prefix', path, handler });
      logLine('info', `${label} mounted at ${path}`);
      return dispose;
    } catch (error) {
      logLine('warn', `${label} mount failed: ${String((error && error.message) || error)}`);
      return null;
    }
  };

  const writeStoreSafe = (store) => {
    try { writeStore(store); return null; }
    catch (error) { return `config write failed: ${String((error && error.message) || error)}`; }
  };

  const dispose = mount('panel api', '/price-mixer', async (req, res) => {
    const url = new URL(req.url || '/', 'http://dsh.internal');
    const tail = url.pathname.replace(/^\/price-mixer\/?/, '').replace(/\/+$/, '');

    if (req.method === 'GET' && (tail === '' || tail === 'status')) {
      const store = readStore();
      return sendJson(res, 200, {
        ok: true,
        configFile: CONFIG_PATH,
        installed: STATE.installed,
        wrappedFetches: STATE.wrappedFetches,
        injections: STATE.injections,
        lastInjection: STATE.lastInjection,
        book: { at: STATE.book.at || null, providers: STATE.book.providers, error: STATE.book.error, loading: !!STATE.book.loading },
        discovery: discoveryView(),
        overrides: Object.keys(store.overrides),
        aliases: store.aliases,
        lastError: STATE.lastError,
        lastLog: STATE.log.slice(-25),
      });
    }

    if (req.method === 'GET' && tail === 'models') {
      ensureBook(url.searchParams.get('force') === '1');
      return sendJson(res, 200, {
        ok: true,
        configFile: CONFIG_PATH,
        bookSeen: STATE.lastModels !== null,
        book: { at: STATE.book.at || null, providers: STATE.book.providers, error: STATE.book.error, loading: !!STATE.book.loading },
        discovery: discoveryView(),
        models: modelRows(),
      });
    }

    if (req.method === 'POST' && tail === 'reload') {
      ensureBook(true);
      return sendJson(res, 200, {
        ok: true,
        bookSeen: STATE.lastModels !== null,
        book: { at: STATE.book.at || null, providers: STATE.book.providers, error: STATE.book.error },
        discovery: discoveryView(),
        models: modelRows(),
      });
    }

    if (req.method === 'POST' && tail === 'override') {
      let body;
      try { body = await readJsonBody(req); } catch (error) { return sendJson(res, 400, { ok: false, error: String((error && error.message) || error) }); }
      const model = typeof body.model === 'string' ? body.model : '';
      if (!model) return sendJson(res, 400, { ok: false, error: 'model is required' });
      const cost = cleanCost(body);
      if (!cost) return sendJson(res, 400, { ok: false, error: 'input and output must be non-negative numbers' });
      const store = readStore();
      const failure = writeStoreSafe({ overrides: { ...store.overrides, [model]: cost }, aliases: store.aliases });
      if (failure) return sendJson(res, 500, { ok: false, error: failure });
      logLine('info', `manual price saved for ${model}: in=${cost.input} out=${cost.output} cache_read=${cost.cache_read}`);
      return sendJson(res, 200, { ok: true, saved: model, cost, configFile: CONFIG_PATH, models: recompute() });
    }

    if (req.method === 'POST' && tail === 'reset') {
      let body;
      try { body = await readJsonBody(req); } catch (error) { return sendJson(res, 400, { ok: false, error: String((error && error.message) || error) }); }
      const store = readStore();
      const overrides = { ...store.overrides };
      if (body.all === true) {
        for (const key of Object.keys(overrides)) delete overrides[key];
        logLine('info', 'all manual prices cleared');
      } else {
        const model = typeof body.model === 'string' ? body.model : '';
        if (!model) return sendJson(res, 400, { ok: false, error: 'model is required (or pass {all:true})' });
        delete overrides[model];
        logLine('info', `manual price cleared for ${model}`);
      }
      const failure = writeStoreSafe({ overrides, aliases: store.aliases });
      if (failure) return sendJson(res, 500, { ok: false, error: failure });
      return sendJson(res, 200, { ok: true, models: recompute() });
    }

    if (req.method === 'POST' && tail === 'alias') {
      let body;
      try { body = await readJsonBody(req); } catch (error) { return sendJson(res, 400, { ok: false, error: String((error && error.message) || error) }); }
      const model = typeof body.model === 'string' ? body.model : '';
      if (!model) return sendJson(res, 400, { ok: false, error: 'model is required' });
      const store = readStore();
      const aliases = { ...store.aliases };
      if (body.canonical === null || body.canonical === '') {
        delete aliases[model];
        logLine('info', `alias cleared for ${model}`);
      } else if (typeof body.canonical === 'string') {
        const canonical = body.canonical.trim();
        if (!canonical.includes('/')) return sendJson(res, 400, { ok: false, error: 'canonical must look like "provider/model"' });
        aliases[model] = canonical;
        logLine('info', `alias saved: ${model} -> ${canonical}`);
      } else {
        return sendJson(res, 400, { ok: false, error: 'canonical must be a string or null' });
      }
      const failure = writeStoreSafe({ overrides: store.overrides, aliases });
      if (failure) return sendJson(res, 500, { ok: false, error: failure });
      return sendJson(res, 200, { ok: true, models: recompute() });
    }

    if (req.method === 'POST' && tail === 'rescan') {
      const discovery = discoverModels(true);
      logLine('info', `rescanned config: ${discovery.total} models in ${discovery.providers.length} provider(s)`);
      return sendJson(res, 200, { ok: true, discovery: summaryOf(discovery), models: recompute() });
    }

    return sendJson(res, 404, { ok: false, error: `unknown price-mixer method "${tail}"` });
  });

  if (dispose && typeof ctx.effect === 'function') {
    ctx.effect(() => () => { try { dispose(); } catch { /* already disposed */ } }, 'dsh-price-mixer: routes');
  }
}

// Test hooks: offline verification of the matching engine without a live host.
export const __test = {
  augmentBook, discoverModels, parseModelId, buildBookIndex, matchModel, resolveModel,
  modelRows, readStore, writeStore, CONFIG_PATH, STATE, parseProviderModels, scorePair,
};
