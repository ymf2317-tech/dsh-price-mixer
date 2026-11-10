/**
 * dsh-price-mixer — host half.
 *
 * Transparently augments the models.dev price book that dsh-context fetches,
 * so locally proxied models (agent2api "-max" names, trae/workbuddy sources)
 * get a reference price in the Context panel's Est. Cost card.
 *
 * How: on host start, wrap globalThis.fetch with a shell that matches exactly
 * one URL — https://models.dev/api.json — fetch the real book upstream,
 * inject an extra provider section in memory, return the merged JSON. Every
 * other request passes through untouched. If anything in the augment path
 * throws, the shell falls back to the pristine upstream response, so the worst
 * case is "no custom prices" — never a broken price book.
 *
 * Price resolution (per model id, highest priority first):
 *   1. a hand-written entry in ~/.dsh/price-mixer.json (the panel writes it);
 *   2. strip "-max" and copy the live cost of the canonical book entry;
 *   3. miss -> the model is omitted and stays unpriced, exactly as before.
 *
 * Config file (created on first save from the panel):
 *   %USERPROFILE%/.dsh/price-mixer.json
 *   { "overrides": { "glm-5.3-max": { "input": 1.2, "output": 4.2,
 *                                      "cache_read": 0.3, "cache_write": 1.2 } } }
 * delete a model's key (or the whole file) to fall back to derivation.
 *
 * Routes (mounted on the web server while this plugin is active):
 *   GET  /price-mixer/status    shell state, injection report, recent log
 *   GET  /price-mixer/models    every model + effective price + where it came from
 *   POST /price-mixer/override  { model, input, output, cache_read, cache_write }
 *   POST /price-mixer/reset     { model } | { all: true }
 *
 * Rollback: remove the `dsh-price-mixer` row from cordis.patch.yml and the
 * `file:vendor/dsh-price-mixer` dependency from package.json, restart dsh.
 * The fetch shell dies with the process; nothing on disk is patched.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const BOOK_URL = 'https://models.dev/api.json';
const CONFIG_PATH = join(homedir(), '.dsh', 'price-mixer.json');

// Built-in explicit overrides (USD per 1M tokens), lowest priority of the two
// override sources — the config file wins, so the panel can always override
// what is compiled in here.
// NOTE: dsh-context bills DeepSeek-family providers at 2x during Beijing peak
// hours (the book lists off-peak rates); everything else uses the rate as-is.
const OVERRIDE = {
  // 'model-id': { input: 1, output: 2, cache_read: 0.1, cache_write: 2 },
};

// Derivation table: agent2api model id (after stripping '-max') -> canonical
// "provider/model" in the real models.dev book. Rates are copied live, so
// upstream price changes are followed automatically.
const CANONICAL = {
  // trae "-max" family (strip -max first)
  'Doubao-Seed-2.1-Pro': 'ofox/volcengine/doubao-seed-2.1-pro', // in=0.7072 out=3.536 (volcengine via ofox)
  'Doubao-Seed-Evolving': 'volcengine/doubao-seed-1-8-251228',
  'glm-5.3-flashx': 'zhipuai/glm-5.3-flashx',
  'glm-5.3-flash': 'zhipuai/glm-5.3-flash',
  'glm-5.3': 'zhipuai/glm-5.3',
  'glm-5.2': 'zhipuai/glm-5.2',
  'deepseek-v4.1-flash': 'deepseek/deepseek-v4-flash', // closest official flash tier
  'deepseek-v4-pro': 'deepseek/deepseek-v4-pro',
  'DeepSeek-V4-Pro-Official': 'deepseek/deepseek-v4-pro',
  'kimi-k3.1-pro': 'moonshotai/kimi-k3.1-pro',
  'kimi-k3': 'moonshotai/kimi-k3',
  'kimi-k2.8-preview': 'llmgateway/kimi-k2.8-preview',
  'mimo-v2.6-flash': 'xiaomi/mimo-v2.6-flash',
  'mimo-v2.6-pro': 'xiaomi/mimo-v2.6-pro',
  'minimax-m3.1-flash': 'novita-ai/minimax/minimax-m3.1-flash',
  'minimax-m3': 'minimax/MiniMax-M3',
  'step-5-preview': 'stepfun/step-5-preview',
  'qwen3.8-flash': 'alibaba/qwen3.8-flash',
  'qwen3.8-max': 'alibaba/qwen3.8-max',
};

// Full model list as configured in the agent2api provider (both sources).
const MODELS = [
  // trae (-max)
  'Doubao-Seed-2.1-Pro-max', 'Doubao-Seed-Evolving-max',
  'glm-5.3-flash-max', 'glm-5.3-flashx-max', 'glm-5.3-max',
  'deepseek-v4.1-flash-max', 'DeepSeek-V4-Pro-Official-max',
  'kimi-k3.1-pro-max', 'kimi-k3-max',
  'mimo-v2.6-flash-max', 'mimo-v2.6-pro-max',
  'minimax-m3.1-flash-max', 'minimax-m3-max',
  'step-5-preview-max', 'step-5-preview',
  'qwen3.8-flash-max', 'qwen3.8-max-max',
  'minimax-m3.1-flash',
  // workbuddy (no suffix)
  'glm-5.3', 'glm-5.3-flash', 'glm-5.2',
  'kimi-k3-1', 'kimi-k2.8-preview',
  'deepseek-v4.1-flash', 'deepseek-v4-pro',
  'space-bunny', 'mimo-v2.6-pro', 'kimi-k3.1-pro',
  'hy4free', 'hy4std',
];

const STATE = {
  installed: false,
  wrappedFetches: 0,
  injections: 0,
  lastInjection: null, // { at, derived, explicit, unpriced }
  lastModels: null,    // [{ id, input, output, cache_read, cache_write, source }]
  lastError: null,
  log: [],
  configCache: { at: 0, mtimeMs: -1, overrides: {} },
  book: { at: 0, providers: 0, error: null, loading: null },
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

function readConfig() {
  // Re-read whenever the file changes; the panel writes it, the shell reads it
  // on the next book fetch, so a save lands without a restart.
  let mtimeMs = -1;
  try { mtimeMs = existsSync(CONFIG_PATH) ? statSync(CONFIG_PATH).mtimeMs : -1; } catch {}
  if (STATE.configCache.mtimeMs === mtimeMs && Date.now() - STATE.configCache.at < 1000) {
    return STATE.configCache.overrides;
  }
  let overrides = {};
  if (mtimeMs >= 0) {
    try {
      const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      const raw = parsed && typeof parsed === 'object' ? parsed.overrides : null;
      if (raw && typeof raw === 'object') {
        for (const [id, value] of Object.entries(raw)) {
          const clean = cleanCost(value);
          if (clean) overrides[id] = clean;
        }
      }
    } catch (error) {
      logLine('warn', `config file unreadable, falling back to derivation only: ${String(error && error.message || error)}`);
      overrides = {};
    }
  }
  STATE.configCache = { at: Date.now(), mtimeMs, overrides };
  return overrides;
}

function writeConfig(overrides) {
  const body = JSON.stringify({ overrides }, null, 2) + '\n';
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const tmp = CONFIG_PATH + '.tmp';
  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, CONFIG_PATH); // atomic-ish replace; a crash never leaves half a file
  STATE.configCache = { at: 0, mtimeMs: -1, overrides };
}

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

/* ------------------------------------------------------------ resolution */

function bookCost(book, provider, key) {
  const cost = book?.[provider]?.models?.[key]?.cost;
  if (!cost || typeof cost.input !== 'number' || typeof cost.output !== 'number') return null;
  return cost;
}

function toPrice(cost, source, canonical) {
  return {
    input: cost.input,
    output: cost.output,
    cache_read: typeof cost.cache_read === 'number' ? cost.cache_read : cost.input,
    cache_write: typeof cost.cache_write === 'number' ? cost.cache_write : cost.input,
    source,
    canonical,
  };
}

// Family hints: an id starting with one of these prefixes is looked up in that
// vendor's section even when the canonical table has no explicit entry.
const FAMILY = {
  glm: 'zhipuai',
  kimi: 'moonshotai',
  mimo: 'xiaomi',
  minimax: 'minimax',
  qwen: 'alibaba',
  step: 'stepfun',
  deepseek: 'deepseek',
  doubao: 'volcengine',
};

// Fuzzy pass, used when the canonical table has no entry (or its entry is gone
// from the book). Two rules:
//   1. same vendor family + identical leaf name (key after the last "/");
//   2. global leaf-name match, accepted only when every provider that lists
//      that name quotes the same input/output — otherwise it is genuinely
//      ambiguous and we leave the model unpriced instead of guessing.
function fuzzyLookup(modelId, book) {
  const wanted = modelId.replace(/-max$/i, '').toLowerCase();
  for (const [prefix, provider] of Object.entries(FAMILY)) {
    if (!wanted.startsWith(prefix)) continue;
    const models = book?.[provider]?.models;
    if (!models || typeof models !== 'object') continue;
    for (const key of Object.keys(models)) {
      if (key.split('/').pop().toLowerCase() !== wanted) continue;
      const cost = bookCost(book, provider, key);
      if (cost) return toPrice(cost, 'fuzzy', `${provider}/${key}`);
    }
  }
  const hits = [];
  for (const [provider, entry] of Object.entries(book ?? {})) {
    const models = entry && typeof entry === 'object' ? entry.models : null;
    if (!models || typeof models !== 'object') continue;
    for (const key of Object.keys(models)) {
      if (key.split('/').pop().toLowerCase() !== wanted) continue;
      const cost = bookCost(book, provider, key);
      if (cost) hits.push({ cost, canonical: `${provider}/${key}` });
    }
  }
  if (hits.length === 0) return null;
  const first = hits[0].cost;
  const agree = hits.every((hit) => hit.cost.input === first.input && hit.cost.output === first.output);
  if (!agree) return { ambiguous: true, count: hits.length };
  return toPrice(first, 'fuzzy', hits[0].canonical);
}

function resolveCost(modelId, book) {
  // 1. config-file override, then the compiled-in one
  const config = readConfig();
  const explicit = cleanCost(config[modelId]) ?? cleanCost(OVERRIDE[modelId]);
  if (explicit) return { ...explicit, source: 'manual' };

  // 2. derivation: strip -max, look up the canonical book entry
  const stripped = modelId.replace(/-max$/i, '');
  const canonical = CANONICAL[stripped] ?? CANONICAL[modelId];
  if (canonical) {
    const slash = canonical.indexOf('/');
    if (slash > 0) {
      const provider = canonical.slice(0, slash);
      const key = canonical.slice(slash + 1);
      const cost = bookCost(book, provider, key);
      if (cost) return toPrice(cost, 'derived', canonical);
    }
  }

  // 3. fuzzy: family prefix, then a globally unambiguous leaf-name match
  return fuzzyLookup(modelId, book);
}

function augmentBook(book) {
  const section = {};
  const report = { derived: [], manual: [], fuzzy: [], unpriced: [] };
  const rows = [];
  for (const id of MODELS) {
    const cost = resolveCost(id, book);
    if (!cost || cost.ambiguous) {
      report.unpriced.push(id);
      rows.push({ id, source: 'none', ambiguous: cost && cost.ambiguous ? cost.count : null });
      continue;
    }
    section[id] = {
      cost: {
        input: cost.input, output: cost.output,
        cache_read: cost.cache_read, cache_write: cost.cache_write,
      },
    };
    if (cost.source === 'manual') report.manual.push(id);
    else if (cost.source === 'fuzzy') report.fuzzy.push(id);
    else report.derived.push(id);
    rows.push({
      id, source: cost.source, canonical: cost.canonical ?? null,
      input: cost.input, output: cost.output,
      cache_read: cost.cache_read, cache_write: cost.cache_write,
    });
  }
  STATE.lastModels = rows;
  // `book` is the pristine upstream object; clone the one provider key in,
  // never mutate the original.
  const merged = { ...book };
  const existing = merged['agent2api'];
  if (existing && typeof existing === 'object') {
    // provider name collision with the real book: merge model-by-model, ours wins
    merged['agent2api'] = { ...existing, models: { ...existing.models, ...section } };
    report.collision = true;
  } else {
    merged['agent2api'] = { name: 'Agent2API (3065) custom prices', models: section };
  }
  return { merged, report };
}

/* ---------------------------------------------------------------- shell */

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
      const { merged, report } = augmentBook(book);
      STATE.injections += 1;
      STATE.lastInjection = { at: Date.now(), ...report };
      logLine('info', `injected ${report.derived.length + report.manual.length + report.fuzzy.length} prices (${report.derived.length} derived, ${report.fuzzy.length} fuzzy, ${report.manual.length} manual, ${report.unpriced.length} unpriced) into book of ${Object.keys(book).length} providers`);
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

function modelRows() {
  const overrides = readConfig();
  const lastById = new Map((STATE.lastModels ?? []).map((row) => [row.id, row]));
  return MODELS.map((id) => {
    const manual = cleanCost(overrides[id]);
    const last = lastById.get(id);
    if (manual) {
      return { id, source: 'manual', editable: true, ...manual, canonical: last?.canonical ?? null };
    }
    if (last && (last.source === 'derived' || last.source === 'fuzzy')) {
      return {
        id, source: last.source, editable: true, canonical: last.canonical,
        input: last.input, output: last.output,
        cache_read: last.cache_read, cache_write: last.cache_write,
      };
    }
    return {
      id, source: 'none', editable: true,
      ambiguous: last?.ambiguous ?? null,
      canonical: CANONICAL[id.replace(/-max$/i, '')] ?? CANONICAL[id] ?? null,
    };
  });
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
      augmentBook(book);
      const priced = (STATE.lastModels ?? []).filter((row) => row.source !== 'none').length;
      STATE.book = { at: Date.now(), providers: Object.keys(book).length, error: null, loading: null };
      logLine('info', `price book loaded for the panel (${STATE.book.providers} providers, ${priced} priced)`);
    } catch (error) {
      STATE.book = { ...STATE.book, error: String((error && error.message) || error), loading: null };
      logLine('warn', `panel book load failed, keeping last known rows: ${STATE.book.error}`);
    }
    return STATE.lastModels;
  })();
  return STATE.lastModels;
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

  const dispose = mount('panel api', '/price-mixer', async (req, res) => {
    const url = new URL(req.url || '/', 'http://dsh.internal');
    const tail = url.pathname.replace(/^\/price-mixer\/?/, '').replace(/\/+$/, '');

    if (req.method === 'GET' && (tail === '' || tail === 'status')) {
      return sendJson(res, 200, {
        ok: true,
        configFile: CONFIG_PATH,
        installed: STATE.installed,
        wrappedFetches: STATE.wrappedFetches,
        injections: STATE.injections,
        lastInjection: STATE.lastInjection,
        book: { at: STATE.book.at || null, providers: STATE.book.providers, error: STATE.book.error },
        lastError: STATE.lastError,
        overrides: Object.keys(readConfig()),
        lastLog: STATE.log.slice(-20),
      });
    }

    if (req.method === 'GET' && tail === 'models') {
      // Load the book ourselves when dsh-context has not fetched it yet, so a
      // freshly restarted host never shows every model as unpriced.
      ensureBook(url.searchParams.get('force') === '1');
      return sendJson(res, 200, {
        ok: true,
        configFile: CONFIG_PATH,
        bookSeen: STATE.lastModels !== null,
        book: { at: STATE.book.at || null, providers: STATE.book.providers, error: STATE.book.error, loading: !!STATE.book.loading },
        models: modelRows(),
      });
    }

    if (req.method === 'POST' && tail === 'reload') {
      ensureBook(true);
      return sendJson(res, 200, {
        ok: true,
        bookSeen: STATE.lastModels !== null,
        book: { at: STATE.book.at || null, providers: STATE.book.providers, error: STATE.book.error },
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
      const overrides = { ...readConfig(), [model]: cost };
      try { writeConfig(overrides); } catch (error) { return sendJson(res, 500, { ok: false, error: `config write failed: ${String((error && error.message) || error)}` }); }
      logLine('info', `manual price saved for ${model}: in=${cost.input} out=${cost.output} cache_read=${cost.cache_read}`);
      return sendJson(res, 200, { ok: true, saved: model, cost, configFile: CONFIG_PATH, models: modelRows() });
    }

    if (req.method === 'POST' && tail === 'reset') {
      let body;
      try { body = await readJsonBody(req); } catch (error) { return sendJson(res, 400, { ok: false, error: String((error && error.message) || error) }); }
      const overrides = { ...readConfig() };
      if (body.all === true) {
        for (const key of Object.keys(overrides)) delete overrides[key];
        logLine('info', 'all manual prices cleared');
      } else {
        const model = typeof body.model === 'string' ? body.model : '';
        if (!model) return sendJson(res, 400, { ok: false, error: 'model is required (or pass {all:true})' });
        delete overrides[model];
        logLine('info', `manual price cleared for ${model}`);
      }
      try { writeConfig(overrides); } catch (error) { return sendJson(res, 500, { ok: false, error: `config write failed: ${String((error && error.message) || error)}` }); }
      return sendJson(res, 200, { ok: true, models: modelRows() });
    }

    return sendJson(res, 404, { ok: false, error: `unknown price-mixer method "${tail}"` });
  });

  if (dispose && typeof ctx.effect === 'function') {
    ctx.effect(() => () => { try { dispose(); } catch { /* already disposed */ } }, 'dsh-price-mixer: routes');
  }
}

// Test hooks: offline verification of price resolution without a live host.
export const __test = { augmentBook, resolveCost, modelRows, readConfig, writeConfig, CONFIG_PATH, STATE, MODELS, CANONICAL };
