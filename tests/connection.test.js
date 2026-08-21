/**
 * Tests for the CDP connection layer in src/connection.js.
 * Covers connect() retry/backoff, single-flight de-duplication, socket cleanup
 * on failure, stale-client recovery, and the actionable error messages shown
 * when TradingView isn't reachable.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { connect, getClient, reconnectTo, disconnect, getTargetInfo } from '../src/connection.js';

const TARGETS = [
  { id: 'other', type: 'page', url: 'https://example.com/' },
  { id: 'tv-chart', type: 'page', url: 'https://www.tradingview.com/chart/abc/' },
  { id: 'tv-home', type: 'page', url: 'https://www.tradingview.com/' },
];

// ── Mock helpers ─────────────────────────────────────────────────────────

function mockFetch(payload = TARGETS, { ok = true, status = 200, throws = null } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (throws) throw throws();
    return { ok, status, json: async () => payload };
  };
  fn.calls = calls;
  return fn;
}

function mockCdp({ failEnable = false, failConnect = null } = {}) {
  const created = [];
  const fn = async ({ target }) => {
    if (failConnect) throw failConnect();
    const c = new EventEmitter();
    c.target = target;
    c.closed = 0;
    c.alive = true;
    c.Runtime = {
      enable: async () => { if (failEnable) throw new Error('Runtime.enable failed'); },
      evaluate: async () => {
        if (!c.alive) throw new Error('websocket is closed');
        return { result: { value: 1 } };
      },
    };
    c.Page = { enable: async () => {} };
    c.DOM = { enable: async () => {} };
    c.close = async () => { c.closed++; };
    created.push(c);
    return c;
  };
  fn.created = created;
  return fn;
}

function mockDelay() {
  const waited = [];
  const fn = async (ms) => { waited.push(ms); };
  fn.waited = waited;
  return fn;
}

function deps(overrides = {}) {
  return { cdp: mockCdp(), fetch: mockFetch(), delay: mockDelay(), ...overrides };
}

const refused = () => Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9222'), { code: 'ECONNREFUSED' }),
});

// Module state is a singleton — start every test from a clean slate.
beforeEach(async () => { await disconnect(); });

// ── Target selection ─────────────────────────────────────────────────────

describe('connect() — target selection', () => {
  it('prefers a /chart/ target over a bare tradingview page', async () => {
    const _deps = deps();
    await connect(null, { _deps });
    assert.equal(_deps.cdp.created[0].target, 'tv-chart');
  });

  it('falls back to any tradingview page when no chart tab is open', async () => {
    const _deps = deps({ fetch: mockFetch([TARGETS[0], TARGETS[2]]) });
    await connect(null, { _deps });
    assert.equal(_deps.cdp.created[0].target, 'tv-home');
  });

  it('reports a missing target instead of a bare CDP error', async () => {
    const _deps = deps({ fetch: mockFetch([TARGETS[0]]) });
    await assert.rejects(
      connect(null, { _deps }),
      /No TradingView chart target found/,
    );
  });

  it('bounds the /json/list request with an abort signal', async () => {
    const _deps = deps();
    await connect(null, { _deps });
    const { opts } = _deps.fetch.calls[0];
    assert.ok(opts?.signal, '/json/list was issued without a timeout signal');
    assert.equal(typeof opts.signal.aborted, 'boolean');
  });
});

// ── Single-flight ────────────────────────────────────────────────────────

describe('connect() — single-flight', () => {
  it('opens one socket for concurrent callers', async () => {
    const _deps = deps();
    const [a, b, c] = await Promise.all([
      connect(null, { _deps }),
      getClient({ _deps }),
      getClient({ _deps }),
    ]);
    assert.equal(_deps.cdp.created.length, 1, 'concurrent callers each opened a socket');
    assert.equal(a, b);
    assert.equal(b, c);
  });

  it('serializes connects to different targets rather than racing them', async () => {
    const _deps = deps();
    const [first, second] = await Promise.all([
      connect('tv-chart', { _deps }),
      connect('tv-home', { _deps }),
    ]);
    assert.equal(_deps.cdp.created.length, 2);
    assert.equal(first.target, 'tv-chart');
    assert.equal(second.target, 'tv-home');
    // The last connect to finish is the one left cached.
    assert.equal((await getTargetInfo()).id, second.target);
  });

  it('reuses the cached client on the next call', async () => {
    const _deps = deps();
    const first = await connect(null, { _deps });
    const second = await getClient({ _deps });
    assert.equal(first, second);
    assert.equal(_deps.cdp.created.length, 1);
  });
});

// ── Failure handling ─────────────────────────────────────────────────────

describe('connect() — failure handling', () => {
  it('closes the socket when a domain fails to enable', async () => {
    const _deps = deps({ cdp: mockCdp({ failEnable: true }) });
    await assert.rejects(connect(null, { _deps }), /Runtime\.enable failed/);
    assert.equal(_deps.cdp.created.length, 5, 'expected one socket per retry');
    for (const c of _deps.cdp.created) {
      assert.equal(c.closed, 1, 'a half-opened socket was left behind');
    }
  });

  it('leaves no client cached after a failed connect', async () => {
    const _deps = deps({ cdp: mockCdp({ failEnable: true }) });
    await assert.rejects(connect(null, { _deps }));
    const healthy = deps();
    await getClient({ _deps: healthy });
    assert.equal(healthy.cdp.created.length, 1, 'a dead client was served from cache');
  });

  it('does not sleep after the final attempt', async () => {
    const _deps = deps({ fetch: mockFetch(TARGETS, { throws: refused }) });
    await assert.rejects(connect(null, { _deps }));
    assert.equal(_deps.delay.waited.length, 4, 'the last retry slept before throwing');
    assert.deepEqual(_deps.delay.waited, [500, 1000, 2000, 4000]);
  });

  it('explains how to fix a refused connection', async () => {
    const _deps = deps({ fetch: mockFetch(TARGETS, { throws: refused }) });
    await assert.rejects(connect(null, { _deps }), (err) => {
      assert.match(err.message, /nothing is listening on/);
      assert.match(err.message, /remote-debugging-port/);
      assert.match(err.message, /TV_CDP_HOST/);
      return true;
    });
  });

  it('flags an endpoint that answers but is not DevTools', async () => {
    const _deps = deps({ fetch: mockFetch([], { ok: false, status: 404 }) });
    await assert.rejects(connect(null, { _deps }), /HTTP 404/);
  });

  it('flags a non-array /json/list payload', async () => {
    const _deps = deps({ fetch: mockFetch({ error: 'nope' }) });
    await assert.rejects(connect(null, { _deps }), /unexpected payload/);
  });
});

// ── Stale-client recovery ────────────────────────────────────────────────

describe('getClient() — stale client recovery', () => {
  it('reconnects when the liveness probe fails', async () => {
    const _deps = deps();
    const first = await connect(null, { _deps });
    first.alive = false; // socket died without an event
    const second = await getClient({ _deps });
    assert.notEqual(first, second);
    assert.equal(first.closed, 1, 'the dead socket was not closed');
    assert.equal(_deps.cdp.created.length, 2);
  });

  it('forgets the client as soon as the transport disconnects', async () => {
    const _deps = deps();
    const first = await connect(null, { _deps });
    first.emit('disconnect');
    const second = await getClient({ _deps });
    assert.notEqual(first, second);
    assert.equal(_deps.cdp.created.length, 2);
  });
});

// ── reconnectTo / disconnect ─────────────────────────────────────────────

describe('reconnectTo() and disconnect()', () => {
  it('switches targets and closes the previous socket', async () => {
    const _deps = deps();
    const first = await connect(null, { _deps });
    const second = await reconnectTo('tv-home', { _deps });
    assert.equal(first.closed, 1);
    assert.equal(second.target, 'tv-home');
    assert.equal((await getTargetInfo()).id, 'tv-home');
  });

  it('closes the socket and clears the cache', async () => {
    const _deps = deps();
    const first = await connect(null, { _deps });
    await disconnect();
    assert.equal(first.closed, 1);
    const next = deps();
    await getClient({ _deps: next });
    assert.equal(next.cdp.created.length, 1);
  });

  it('is a no-op when nothing is connected', async () => {
    await disconnect();
    await disconnect();
  });
});
