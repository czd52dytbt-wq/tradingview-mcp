import CDP from 'chrome-remote-interface';

let client = null;
let targetInfo = null;
// In-flight connect(), shared by concurrent callers so a burst of tool calls
// opens one socket instead of racing to overwrite `client` with N of them.
let connecting = null;
let connectingTarget;
// Overridable via TV_CDP_HOST/TV_CDP_PORT (or CDP_HOST/CDP_PORT) env vars.
// Default is 127.0.0.1, not localhost: on some Windows machines localhost
// resolves to ::1 first, and Electron's --remote-debugging-port only listens on IPv4.
export const CDP_HOST = process.env.TV_CDP_HOST || process.env.CDP_HOST || '127.0.0.1';
export const CDP_PORT = Number(process.env.TV_CDP_PORT || process.env.CDP_PORT) || 9222;
const MAX_RETRIES = 5;
const BASE_DELAY = 500;
// HTTP timeout for /json/list. Without one, a dropped packet (VPN, firewall
// rule, suspended VM) hangs the fetch — and the MCP tool call — indefinitely.
const LIST_TIMEOUT = 5000;
// Cap on the cached-client liveness probe. A half-open websocket accepts the
// write and never answers, so the probe needs its own deadline.
const LIVENESS_TIMEOUT = 5000;

// Known direct API paths discovered via live probing (see PROBE_RESULTS.md)
const KNOWN_PATHS = {
  chartApi: 'window.TradingViewApi._activeChartWidgetWV.value()',
  chartWidgetCollection: 'window.TradingViewApi._chartWidgetCollection',
  bottomWidgetBar: 'window.TradingView.bottomWidgetBar',
  replayApi: 'window.TradingViewApi._replayApi',
  alertService: 'window.TradingViewApi._alertService',
  chartApiInstance: 'window.ChartApiInstance',
  mainSeriesBars: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()',
  // Phase 1: Strategy data — model().dataSources() → find strategy → .performance().value(), .ordersData(), .reportData()
  strategyStudy: 'chart._chartWidget.model().model().dataSources()',
  // Phase 2: Layouts — getSavedCharts(cb), loadChartFromServer(id)
  layoutManager: 'window.TradingViewApi.getSavedCharts',
  // Phase 5: Symbol search — searchSymbols(query) returns Promise
  symbolSearchApi: 'window.TradingViewApi.searchSymbols',
  // Phase 6: Pine scripts — REST API at pine-facade.tradingview.com/pine-facade/list/?filter=saved
  pineFacadeApi: 'https://pine-facade.tradingview.com/pine-facade',
};

export { KNOWN_PATHS };

/**
 * Sanitize a string for safe interpolation into JavaScript code evaluated via CDP.
 * Uses JSON.stringify to produce a properly escaped JS string literal (with quotes).
 * Prevents injection via quotes, backticks, template literals, or control chars.
 */
export function safeString(str) {
  return JSON.stringify(String(str));
}

/**
 * Validate that a value is a finite number. Throws if NaN, Infinity, or non-numeric.
 * Prevents corrupt values from reaching TradingView APIs that persist to cloud state.
 */
export function requireFinite(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number, got: ${value}`);
  return n;
}

function _resolve(deps) {
  return {
    cdp: deps?.cdp || CDP,
    fetch: deps?.fetch || ((...args) => fetch(...args)),
    delay: deps?.delay || ((ms) => new Promise(r => setTimeout(r, ms))),
  };
}

/** Reject if `promise` hasn't settled within `ms`. */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Drop the cached client, closing its socket so we don't leak the connection. */
async function dropClient() {
  const dead = client;
  client = null;
  targetInfo = null;
  if (dead) {
    try { await dead.close(); } catch { /* already gone */ }
  }
}

/**
 * Turn a raw connect failure into something the user can act on.
 * The common case — TradingView simply isn't running with CDP enabled —
 * otherwise surfaces as a bare "fetch failed".
 */
function describeError(err) {
  const msg = err?.message || String(err);
  const code = err?.code || err?.cause?.code || err?.cause?.name || err?.name;
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(msg)) {
    return `nothing is listening on ${CDP_HOST}:${CDP_PORT}. Start TradingView Desktop with --remote-debugging-port=${CDP_PORT} (the tv_launch tool does this for you), or point TV_CDP_HOST/TV_CDP_PORT at where it is listening.`;
  }
  if (code === 'TimeoutError' || code === 'ETIMEDOUT' || /timed out/i.test(msg)) {
    return `${CDP_HOST}:${CDP_PORT} accepted the request but never answered — a firewall or a stale process may be holding the port.`;
  }
  return msg;
}

export async function getClient({ _deps } = {}) {
  if (client) {
    try {
      // Quick liveness check — bounded, because a half-open socket never replies.
      await withTimeout(
        client.Runtime.evaluate({ expression: '1', returnByValue: true }),
        LIVENESS_TIMEOUT,
        'CDP liveness check timed out',
      );
      return client;
    } catch {
      await dropClient();
    }
  }
  return connect(null, { _deps });
}

export async function connect(targetId = null, { _deps } = {}) {
  // Share an in-flight attempt for the same target; serialize behind one for a
  // different target so two connects can't both assign `client`.
  if (connecting) {
    if (connectingTarget === targetId) return connecting;
    await connecting.catch(() => {});
    return connect(targetId, { _deps });
  }
  connectingTarget = targetId;
  connecting = attemptConnect(targetId, _deps).finally(() => {
    connecting = null;
    connectingTarget = undefined;
  });
  return connecting;
}

async function attemptConnect(targetId, _deps) {
  const deps = _resolve(_deps);
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let fresh = null;
    try {
      const target = targetId
        ? await findTargetById(targetId, deps)
        : await findChartTarget(deps);
      if (!target) {
        throw new Error(targetId
          ? `CDP target ${targetId} not found — is the tab still open?`
          : 'No TradingView chart target found. Is TradingView open with a chart?');
      }

      fresh = await deps.cdp({ host: CDP_HOST, port: CDP_PORT, target: target.id });

      // Enable required domains
      await fresh.Runtime.enable();
      await fresh.Page.enable();
      await fresh.DOM.enable();

      // Forget the client the moment its transport dies, so the next call
      // reconnects instead of probing a socket we already know is gone.
      fresh.on?.('disconnect', () => {
        if (client === fresh) { client = null; targetInfo = null; }
      });

      client = fresh;
      targetInfo = target;
      return client;
    } catch (err) {
      lastError = err;
      // CDP() can hand back a socket and a later enable() still throw — closing
      // it here keeps failed retries from leaking a connection apiece.
      if (fresh) { try { await fresh.close(); } catch { /* already gone */ } }
      // No sleep after the final attempt; it only delays the error.
      if (attempt < MAX_RETRIES - 1) {
        await deps.delay(Math.min(BASE_DELAY * Math.pow(2, attempt), 30000));
      }
    }
  }
  throw new Error(`CDP connection failed after ${MAX_RETRIES} attempts: ${describeError(lastError)}`);
}

/**
 * Re-attach the cached CDP client to a specific target id.
 * Used by tab_switch so subsequent reads (chart_get_state, data_get_*,
 * quote_get, screenshots) follow the activated tab instead of staying
 * glued to the target picked at first connect.
 */
export async function reconnectTo(targetId, { _deps } = {}) {
  await dropClient();
  return connect(targetId, { _deps });
}

async function listTargets(deps) {
  let resp;
  try {
    resp = await deps.fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`, {
      signal: AbortSignal.timeout(LIST_TIMEOUT),
    });
  } catch (err) {
    // fetch() reports the real cause (ECONNREFUSED, timeout) on err.cause —
    // carry it through so describeError() can say what actually went wrong.
    throw Object.assign(
      new Error(`Cannot reach CDP at ${CDP_HOST}:${CDP_PORT}: ${err?.message || err}`),
      { code: err?.code || err?.cause?.code || err?.name, cause: err },
    );
  }
  if (!resp.ok) {
    throw new Error(`CDP /json/list returned HTTP ${resp.status} — is ${CDP_HOST}:${CDP_PORT} really a DevTools endpoint?`);
  }
  const targets = await resp.json();
  if (!Array.isArray(targets)) {
    throw new Error('CDP /json/list returned an unexpected payload (expected an array of targets)');
  }
  return targets;
}

async function findChartTarget(deps) {
  const targets = await listTargets(deps);
  // Prefer targets with tradingview.com/chart in the URL
  return targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    || targets.find(t => t.type === 'page' && /tradingview/i.test(t.url))
    || null;
}

async function findTargetById(id, deps) {
  const targets = await listTargets(deps);
  return targets.find(t => t.id === id) || null;
}

export async function getTargetInfo() {
  if (!targetInfo) {
    await getClient();
  }
  return targetInfo;
}

export async function evaluate(expression, opts = {}) {
  const c = await getClient();
  const result = await c.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise ?? false,
    ...opts,
  });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluateAsync(expression) {
  return evaluate(expression, { awaitPromise: true });
}

export async function disconnect() {
  // Let any in-flight connect settle first, otherwise it assigns `client`
  // right after we clear it and the socket outlives the disconnect.
  if (connecting) await connecting.catch(() => {});
  await dropClient();
}

// --- Direct API path helpers ---
// Each returns the STRING expression path after verifying it exists.
// Callers use the returned string in their own evaluate() calls.

async function verifyAndReturn(path, name) {
  const exists = await evaluate(`typeof (${path}) !== 'undefined' && (${path}) !== null`);
  if (!exists) {
    throw new Error(`${name} not available at ${path}`);
  }
  return path;
}

export async function getChartApi() {
  return verifyAndReturn(KNOWN_PATHS.chartApi, 'Chart API');
}

export async function getChartCollection() {
  return verifyAndReturn(KNOWN_PATHS.chartWidgetCollection, 'Chart Widget Collection');
}

export async function getBottomBar() {
  return verifyAndReturn(KNOWN_PATHS.bottomWidgetBar, 'Bottom Widget Bar');
}

export async function getReplayApi() {
  return verifyAndReturn(KNOWN_PATHS.replayApi, 'Replay API');
}

export async function getMainSeriesBars() {
  return verifyAndReturn(KNOWN_PATHS.mainSeriesBars, 'Main Series Bars');
}
