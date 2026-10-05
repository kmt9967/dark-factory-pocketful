'use strict';
// Stage-3 W3b self-tests: payment corrections, revisions, historical overdraft (total and available),
// known_at over multiple revisions, snapshots, linked-payment immutability, concurrency, export/import.
// Run: node stage-3/test/probe3b.js   (spawns stage-3 server.js)   or BASE=... for a container.
const { spawn } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');

const BASE = process.env.BASE || `http://127.0.0.1:${16000 + Math.floor(Math.random() * 900)}`;
let failures = 0, passes = 0;
async function call(method, p, { body, raw, token, key } = {}) {
  const h = {};
  if (token) h.authorization = `Bearer ${token}`;
  if (key !== undefined) h['idempotency-key'] = key;
  let payload;
  if (raw !== undefined) payload = raw; else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const r = await fetch(BASE + p, { method, headers: h, body: payload });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, body: json };
}
const k = () => 'k' + Math.random().toString(36).slice(2) + Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
const U = (h, bal) => ({ id: `u_${h}`, email: `${h}@example.com`, password: 'correct horse', display_name: h, handle: h, balance: bal });
const nsOf = (iso) => {
  const m = /^(.*T\d\d:\d\d:\d\d)(?:\.(\d+))?([Zz]|[+-]\d\d:\d\d)$/.exec(iso);
  return BigInt(Date.parse(m[1] + m[3])) * 1000000n + BigInt(((m[2] || '') + '000000000').slice(0, 9));
};
const isoNs = (ns) => new Date(Number(ns / 1000000n)).toISOString().replace(/Z$/, String(ns % 1000000n).padStart(6, '0') + '+00:00');
const shift = (iso, ms) => isoNs(nsOf(iso) + BigInt(Math.round(ms * 1e6)));
const toOffset = (iso, hours) => { // same instant written with another offset
  const d = new Date(Date.parse(iso) + hours * 3600e3).toISOString().slice(0, 23);
  const sign = hours >= 0 ? '+' : '-', hh = String(Math.abs(hours)).padStart(2, '0');
  return `${d}${sign}${hh}:00`;
};
async function reset(fx) { const r = await call('POST', '/_test/reset', { body: fx }); assert.equal(r.status, 204, JSON.stringify(r.body)); }
async function login(h) { const r = await call('POST', '/auth/login', { body: { email: `${h}@example.com`, password: 'correct horse' } }); assert.equal(r.status, 200); return r.body.token; }
async function world(users = [U('ada', 10000), U('bob', 2500), U('cy', 500)], extra = {}) {
  await reset({ currency: 'EUR', minor_units: 2, users, ...extra });
  const w = {};
  for (const u of users) w[u.handle] = await login(u.handle);
  return w;
}
const pay = async (t, to, amount) => { const r = await call('POST', '/payments', { token: t, key: k(), body: { to_handle: to, amount } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; };
const correct = (t, pid, body, key = k()) => call('POST', `/payments/${pid}/corrections`, { token: t, key, body });
const C = (er, amount, effective_at, reason = 'fix') => ({ expected_revision: er, amount, effective_at, reason });
const bal = async (t, qs = '') => (await call('GET', '/me' + qs, { token: t })).body.balance;
const err = (r, status, code) => { assert.equal(r.status, status, JSON.stringify(r.body)); if (code) assert.equal(r.body.error.code, code, JSON.stringify(r.body)); };
// "Now" for effective_at, 1.5 s in the past: a client's clock reading can be a few ms ahead of the
// server's on this host, and the server rightly rejects an effective_at later than its now.
const nowIso = () => new Date(Date.now() - 1500).toISOString().replace('Z', '+00:00');
const tests = [];
const test = (n, f) => tests.push([n, f]);

test('increase, decrease, zero: money moves between the same two wallets; response shape', async () => {
  const w = await world();
  const p = await pay(w.ada, 'bob', 1000);
  const eff = toOffset(p.created_at, 2);
  const r = await correct(w.ada, p.payment_id, C(1, 1500, eff, 'forgot the tip'));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // stage 4 adds correction_batch_id (null for single corrections)
  assert.deepEqual(Object.keys(r.body).sort(), ['amount', 'correction_batch_id', 'effective_at', 'payment_id', 'reason', 'recorded_at', 'revision']);
  assert.equal(r.body.correction_batch_id, null);
  assert.equal(r.body.revision, 2); assert.equal(r.body.amount, 1500); assert.equal(r.body.effective_at, eff);
  assert.equal(r.body.reason, 'forgot the tip'); assert.match(r.body.recorded_at, /\+00:00$/);
  assert.ok(nsOf(r.body.recorded_at) > nsOf(p.created_at));
  assert.equal(await bal(w.ada), 8500); assert.equal(await bal(w.bob), 4000);
  const d = await correct(w.ada, p.payment_id, C(2, 400, nowIso()));
  assert.equal(d.status, 201); assert.equal(await bal(w.ada), 9600); assert.equal(await bal(w.bob), 2900);
  assert.ok(nsOf(d.body.recorded_at) > nsOf(r.body.recorded_at));
  const z = await correct(w.ada, p.payment_id, C(3, 0, nowIso(), 'refund in full'));
  assert.equal(z.status, 201); assert.equal(await bal(w.ada), 10000); assert.equal(await bal(w.bob), 2500);
  const s = (await call('GET', '/statement', { token: w.ada })).body;
  assert.equal(s.entries.length, 1); assert.equal(s.entries[0].delta, 0); assert.equal(s.entries[0].payment.amount, 0);
  assert.equal(s.entries[0].revision, 4);
  // original payment and activity unchanged
  const feed = (await call('GET', '/activity', { token: w.bob })).body.payments;
  assert.equal(feed[0].amount, 1000);
  const revs = (await call('GET', `/payments/${p.payment_id}/revisions`, { token: w.bob })).body.revisions;
  assert.deepEqual(revs.map((x) => [x.revision, x.amount, x.reason]), [[1, 1000, ''], [2, 1500, 'forgot the tip'], [3, 400, 'fix'], [4, 0, 'refund in full']]);
  assert.equal(revs[0].effective_at, p.created_at); assert.equal(revs[0].recorded_at, p.created_at);
  assert.equal(revs[1].effective_at, eff);
});

test('G4 order and precedence pairs', async () => {
  const w = await world([U('ada', 10000), U('bob', 2500), U('cy', 500), U('op', 0)], { settlement_operator_ids: ['u_op'] });
  const p = await pay(w.ada, 'bob', 1000);
  const ok = C(1, 900, nowIso());
  err(await call('POST', `/payments/${p.payment_id}/corrections`, { key: k(), body: ok }), 401, 'unauthenticated');
  err(await call('POST', `/payments/${p.payment_id}/corrections`, { token: w.ada, key: k(), raw: '{nope' }), 400, 'malformed_request');
  err(await call('POST', `/payments/${p.payment_id}/corrections`, { token: w.ada, key: k(), raw: '[1]' }), 400, 'malformed_request');
  err(await call('POST', `/payments/${p.payment_id}/corrections`, { token: w.ada, body: ok }), 400, 'missing_idempotency_key');
  err(await correct(w.ada, p.payment_id, ok, 'x'.repeat(256)), 422, 'validation_failed');
  err(await correct(w.ada, 'p_nope', ok), 404, 'not_found');
  err(await correct(w.ada, 'p_nope', { amount: 'x' }), 404, 'not_found');
  err(await correct(w.bob, p.payment_id, ok), 403, 'forbidden');
  err(await correct(w.cy, p.payment_id, ok), 403, 'forbidden');
  err(await correct(w.bob, p.payment_id, { amount: 'x' }), 403, 'forbidden');
  const bad = [
    { ...ok, expected_revision: 0 }, { ...ok, expected_revision: 1.5 }, { ...ok, expected_revision: '1' }, { ...ok, expected_revision: null },
    { ...ok, amount: -1 }, { ...ok, amount: 1000000001 }, { ...ok, amount: '5' }, { ...ok, amount: 1.5 }, { ...ok, amount: true },
    { ...ok, reason: '' }, { ...ok, reason: 'x'.repeat(201) }, { ...ok, reason: 5 }, { ...ok, reason: null },
    { ...ok, effective_at: shift(nowIso(), 60000) }, { ...ok, effective_at: '2026-01-01T00:00:00' }, { ...ok, effective_at: '2026-01-01' },
    { ...ok, effective_at: '' }, { ...ok, effective_at: 7 },
  ];
  for (const f of ['expected_revision', 'amount', 'reason', 'effective_at']) { const b = { ...ok }; delete b[f]; bad.push(b); }
  for (const b of bad) err(await correct(w.ada, p.payment_id, b), 422, 'validation_failed');
  assert.equal((await correct(w.ada, p.payment_id, { ...ok, reason: '😀'.repeat(200) })).status, 201, '200 code points is fine');
  // stale + invalid -> 422; stale alone -> 409
  err(await correct(w.ada, p.payment_id, { ...ok, amount: -1 }), 422, 'validation_failed');
  err(await correct(w.ada, p.payment_id, ok), 409, 'stale_revision');
  // linked: settlement member and capture -> 422 linked (before stale); linked + invalid -> 422 validation
  const st = await call('POST', '/settlements', { token: w.op, key: k(), body: { transfers: [{ from_handle: 'ada', to_handle: 'cy', amount: 10 }] } });
  const mid = st.body.payments[0].payment_id;
  err(await correct(w.ada, mid, C(1, 5, nowIso())), 422, 'linked_payment_immutable');
  err(await correct(w.ada, mid, C(7, 5, nowIso())), 422, 'linked_payment_immutable');
  err(await correct(w.ada, mid, C(1, -5, nowIso())), 422, 'validation_failed');
  const a = (await call('POST', '/authorizations', { token: w.ada, key: k(), body: { to_handle: 'bob', amount: 300 } })).body;
  const cap = (await call('POST', `/authorizations/${a.authorization_id}/capture`, { token: w.bob, key: k(), body: {} })).body;
  err(await correct(w.ada, cap.payment_id, C(1, 100, nowIso())), 422, 'linked_payment_immutable');
  err(await correct(w.ada, cap.payment_id, C(9, 100, nowIso())), 422, 'linked_payment_immutable');
  // insufficient + historical -> insufficient
  const q = await pay(w.cy, 'bob', 400); // cy 500 + 10 (settlement) - 400 = 110
  // both currently unaffordable and historically negative -> insufficient_funds wins
  err(await correct(w.cy, q.payment_id, C(1, 1000, q.created_at)), 409, 'insufficient_funds');
  // affordable now (+105 <= 110) but negative before the settlement credit -> historical_overdraft
  err(await correct(w.cy, q.payment_id, C(1, 505, '2020-01-01T00:00:00Z')), 409, 'historical_overdraft');
  assert.equal((await correct(w.cy, q.payment_id, C(1, 505, q.created_at))).status, 201);
});

test('failures change nothing and claim no key; replay after newer revisions; reuse 409', async () => {
  const w = await world();
  const p = await pay(w.ada, 'bob', 1000);
  const key = k();
  err(await correct(w.ada, p.payment_id, C(2, 1100, nowIso()), key), 409, 'stale_revision');
  const before = [await bal(w.ada), await bal(w.bob)];
  const revsBefore = (await call('GET', `/payments/${p.payment_id}/revisions`, { token: w.ada })).body;
  const body = C(1, 1100, nowIso());
  const first = await correct(w.ada, p.payment_id, body, key); // same key, now valid: first use
  assert.equal(first.status, 201);
  assert.deepEqual(before, [10000 - 1000, 2500 + 1000]);
  assert.equal(revsBefore.revisions.length, 1);
  await correct(w.ada, p.payment_id, C(2, 1200, nowIso()));
  await correct(w.ada, p.payment_id, C(3, 1300, nowIso()));
  const replay = await correct(w.ada, p.payment_id, body, key);
  assert.equal(replay.status, 200); assert.deepEqual(replay.body, first.body);
  assert.equal(await bal(w.ada), 8700);
  err(await correct(w.ada, p.payment_id, { ...body, reason: 'other' }, key), 409, 'idempotency_key_reuse');
  err(await correct(w.ada, p.payment_id, { amount: 'junk' }, key), 409, 'idempotency_key_reuse');
  // same key + body on another payment's path is a different request
  const p2 = await pay(w.ada, 'bob', 50);
  assert.equal((await correct(w.ada, p2.payment_id, body, key)).status, 201);
  // a historical_overdraft failure leaves history, balances and statements untouched
  const sBefore = (await call('GET', '/statement', { token: w.bob })).body;
  const q = await pay(w.bob, 'cy', 2000); // bob 3700-? keep track via API
  const bobNow = await bal(w.bob);
  err(await correct(w.bob, q.payment_id, C(1, 2000 + bobNow + 1, q.created_at)), 409, 'insufficient_funds');
  assert.equal(await bal(w.bob), bobNow);
  assert.equal((await call('GET', `/payments/${q.payment_id}/revisions`, { token: w.bob })).body.revisions.length, 1);
  const sAgain = (await call('GET', `/statement?snapshot=${sBefore.snapshot}`, { token: w.bob })).body;
  assert.deepEqual(sAgain.entries, sBefore.entries);
});

test('historical_overdraft: moving a payment backwards across another (total)', async () => {
  const w = await world();
  const t1 = await pay(w.bob, 'cy', 1000); // cy 1500
  await sleep(3);
  const t2 = await pay(w.cy, 'ada', 1200); // cy 300
  err(await correct(w.cy, t2.payment_id, C(1, 1200, shift(t1.created_at, -1))), 409, 'historical_overdraft');
  err(await correct(w.cy, t2.payment_id, C(1, 1200, '2020-01-01T00:00:00Z')), 409, 'historical_overdraft');
  // exactly at t1 is fine (credit and debit at the same instant combine)
  const r = await correct(w.cy, t2.payment_id, C(1, 1200, t1.created_at));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // and moving it forward again is fine
  await sleep(1600); // nowIso() trails real time by 1.5 s
  assert.equal((await correct(w.cy, t2.payment_id, C(2, 1200, nowIso()))).status, 201);
  assert.equal(await bal(w.cy), 300);
});

test('historical_overdraft: only historical AVAILABLE goes negative because of a hold', async () => {
  const w = await world();
  const p = await pay(w.ada, 'cy', 500); // ada 9500
  await sleep(3);
  const a = (await call('POST', '/authorizations', { token: w.ada, key: k(), body: { to_handle: 'bob', amount: 9000 } })).body;
  await sleep(3);
  await call('POST', `/authorizations/${a.authorization_id}/void`, { token: w.ada }); // available 9500 again
  // +700 is affordable now (available 9500) and total stays >= 0 everywhere, but at the hold's
  // creation available would be 10000 - 1200 - 9000 = -200.
  err(await correct(w.ada, p.payment_id, C(1, 1200, p.created_at)), 409, 'historical_overdraft');
  assert.equal((await call('GET', `/me?as_of=${enc(a.created_at)}`, { token: w.ada })).body.available, 500);
  // +500 keeps available at exactly 0 then: accepted
  assert.equal((await correct(w.ada, p.payment_id, C(1, 1000, p.created_at))).status, 201);
  assert.equal((await call('GET', `/me?as_of=${enc(a.created_at)}`, { token: w.ada })).body.available, 0);
  // effective after the void: the hold no longer constrains it
  await sleep(1600); // nowIso() trails real time by 1.5 s
  assert.equal((await correct(w.ada, p.payment_id, C(2, 1400, nowIso()))).status, 201);
});

test('a same-instant boundary that is only fine when movements are combined', async () => {
  const w = await world([U('dee', 100), U('eve', 0), U('fay', 0), U('op', 0)], { settlement_operator_ids: ['u_op'] });
  const pa = await pay(w.dee, 'eve', 100); // dee 0
  await sleep(3);
  const st = await call('POST', '/settlements', { token: w.op, key: k(), body: { transfers: [
    { from_handle: 'eve', to_handle: 'dee', amount: 50 }, { from_handle: 'dee', to_handle: 'fay', amount: 50 }] } });
  assert.equal(st.status, 201);
  const T = st.body.committed_at;
  // move dee's payment to the settlement instant: at T dee has 100 - 100 + 50 - 50 = 0 (combined)
  const r = await correct(w.dee, pa.payment_id, C(1, 100, T));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(await bal(w.dee, `?as_of=${enc(T)}`), 0);
  assert.equal(await bal(w.dee, `?as_of=${enc(shift(T, -0.001))}`), 100);
  // the receiving side is consistent too: eve gets 100 and pays 50 at T
  const eve = await login('eve');
  assert.equal(await bal(eve, `?as_of=${enc(T)}`), 50);
  assert.equal(await bal(eve, `?as_of=${enc(shift(T, -0.001))}`), 0);
});

test('50 concurrent corrections with the same expected revision: exactly one succeeds', async () => {
  const w = await world();
  const p = await pay(w.ada, 'bob', 1000);
  const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => correct(w.ada, p.payment_id, C(1, 1001 + i, nowIso()))));
  assert.ok(rs.every((r) => r.status < 500));
  const wins = rs.filter((r) => r.status === 201);
  assert.equal(wins.length, 1);
  assert.equal(rs.filter((r) => r.status === 409 && r.body.error.code === 'stale_revision').length, 49);
  assert.equal(await bal(w.ada), 10000 - wins[0].body.amount);
  assert.equal((await bal(w.ada)) + (await bal(w.bob)) + (await bal(w.cy)), 13000);
});

test('known_at before/after a correction in /me and /statement; snapshots unchanged; Σ conserved', async () => {
  const w = await world();
  const p = await pay(w.ada, 'bob', 1000);
  await sleep(3);
  const s0 = (await call('GET', '/statement', { token: w.ada })).body;
  const r = (await correct(w.ada, p.payment_id, C(1, 600, p.created_at))).body;
  const before = shift(r.recorded_at, -0.001);
  assert.equal(await bal(w.ada, `?known_at=${enc(before)}`), 9000);
  assert.equal(await bal(w.ada, `?known_at=${enc(r.recorded_at)}`), 9400);
  assert.equal(await bal(w.ada, `?as_of=${enc(p.created_at)}&known_at=${enc(before)}`), 9000);
  assert.equal(await bal(w.ada), 9400);
  const sb = (await call('GET', `/statement?known_at=${enc(before)}`, { token: w.ada })).body;
  assert.equal(sb.entries[0].payment.amount, 1000); assert.equal(sb.entries[0].revision, 1);
  const sa = (await call('GET', '/statement', { token: w.ada })).body;
  assert.equal(sa.entries.length, 1, 'never counted alongside the revision it replaces');
  assert.equal(sa.entries[0].payment.amount, 600); assert.equal(sa.entries[0].revision, 2);
  assert.equal(sa.entries[0].recorded_at, r.recorded_at); assert.equal(sa.entries[0].delta, -600);
  assert.equal(sa.closing_balance, 9400);
  const again = (await call('GET', `/statement?snapshot=${s0.snapshot}`, { token: w.ada })).body;
  assert.deepEqual(again.entries, s0.entries); assert.equal(again.closing_balance, 9000);
  // Σ over all users in several historical views equals the seeded total
  const views = ['', `?as_of=${enc(p.created_at)}`, `?known_at=${enc(before)}`, `?as_of=2020-01-01T00:00:00Z`, `?as_of=2999-01-01T00:00:00Z&known_at=${enc(before)}`];
  for (const v of views) {
    const sum = (await bal(w.ada, v)) + (await bal(w.bob, v)) + (await bal(w.cy, v));
    assert.equal(sum, 13000, `view ${v}`);
  }
  // original receipt unchanged on replay of the payment itself
  const feed = (await call('GET', '/activity', { token: w.ada })).body.payments;
  assert.equal(feed[0].amount, 1000);
});

test('a correction moves a payment into and out of a statement window', async () => {
  const w = await world();
  const p1 = await pay(w.ada, 'bob', 100);
  await sleep(5);
  const p2 = await pay(w.ada, 'bob', 200);
  await sleep(5);
  const p3 = await pay(w.ada, 'bob', 300);
  const win = `?from=${enc(p2.created_at)}&to=${enc(p3.created_at)}`;
  let s = (await call('GET', '/statement' + win, { token: w.ada })).body;
  assert.deepEqual(s.entries.map((e) => e.payment.payment_id), [p2.payment_id]);
  // p3 moved back into the window (between p1 and p2? no: at p2's instant, ordered by id)
  assert.equal((await correct(w.ada, p3.payment_id, C(1, 300, p2.created_at))).status, 201);
  s = (await call('GET', '/statement' + win, { token: w.ada })).body;
  assert.deepEqual(s.entries.map((e) => e.payment.payment_id).sort(), [p2.payment_id, p3.payment_id].sort());
  const ids = s.entries.map((e) => e.payment.payment_id);
  assert.deepEqual(ids, [...ids].sort(), 'ties at one effective instant are in id order');
  assert.equal(s.opening_balance, 9900); assert.equal(s.closing_balance, 9400);
  // p2 moved before the window: out of it, and the opening balance absorbs it
  assert.equal((await correct(w.ada, p2.payment_id, C(1, 200, p1.created_at))).status, 201);
  s = (await call('GET', '/statement' + win, { token: w.ada })).body;
  assert.deepEqual(s.entries.map((e) => e.payment.payment_id), [p3.payment_id]);
  assert.equal(s.opening_balance, 9700); assert.equal(s.closing_balance, 9400);
});

test('request payments may be corrected; revisions read rules', async () => {
  const w = await world();
  const rq = (await call('POST', '/requests', { token: w.bob, key: k(), body: { payer_handle: 'ada', amount: 700 } })).body;
  const paid = (await call('POST', `/requests/${rq.request_id}/pay`, { token: w.ada, key: k() })).body;
  assert.equal((await correct(w.ada, paid.payment_id, C(1, 650, nowIso()))).status, 201);
  err(await call('GET', `/payments/${paid.payment_id}/revisions`), 401);
  err(await call('GET', `/payments/${paid.payment_id}/revisions`, { token: w.cy }), 404, 'not_found');
  err(await call('GET', '/payments/p_nope/revisions', { token: w.ada }), 404, 'not_found');
  const rv = (await call('GET', `/payments/${paid.payment_id}/revisions`, { token: w.bob })).body.revisions;
  assert.equal(rv.length, 2); assert.equal(rv[0].reason, '');
  const pub = await pay(w.ada, 'bob', 1); // public, still hidden from a third party
  err(await call('GET', `/payments/${pub.payment_id}/revisions`, { token: w.cy }), 404, 'not_found');
});

test('export/import of a corrected state; stage discipline (no stage-4 surfaces)', async () => {
  const w = await world();
  const p = await pay(w.ada, 'bob', 1000);
  const key = k();
  const r = await correct(w.ada, p.payment_id, C(1, 800, p.created_at), key);
  const s = (await call('GET', '/statement', { token: w.ada })).body;
  const ex = (await call('GET', '/_test/export')).body;
  await reset({ currency: 'EUR', minor_units: 2, users: [U('zz', 1)] });
  assert.equal((await call('POST', '/_test/import', { body: ex })).status, 204);
  assert.equal(await bal(w.ada), 9200);
  assert.deepEqual((await call('GET', `/statement?snapshot=${s.snapshot}`, { token: w.ada })).body.entries, s.entries);
  const replay = await correct(w.ada, p.payment_id, C(1, 800, p.created_at), key);
  assert.equal(replay.status, 200); assert.deepEqual(replay.body, r.body);
  err(await correct(w.ada, p.payment_id, C(1, 700, nowIso())), 409, 'stale_revision');
  const r3 = await correct(w.ada, p.payment_id, C(2, 700, nowIso()));
  assert.equal(r3.status, 201); assert.ok(nsOf(r3.body.recorded_at) > nsOf(r.body.recorded_at));
  const bad = JSON.parse(JSON.stringify(ex)); bad.state.revisions[0][1][1].amount += 1;
  err(await call('POST', '/_test/import', { body: bad }), 422, 'validation_failed');
  // stage 4: refunds exist (the sender may not refund), payments carry refund_of: null
  err(await call('POST', `/payments/${p.payment_id}/refunds`, { token: w.ada, key: k(), body: { amount: 1 } }), 403, 'forbidden');
  err(await call('POST', '/refunds', { token: w.ada, key: k(), body: {} }), 404);
  err(await call('POST', '/corrections', { token: w.ada, key: k(), body: {} }), 404);
  const pv = (await call('GET', '/activity', { token: w.ada })).body.payments[0];
  assert.equal(pv.refund_of, null);
});

(async () => {
  let kid = null;
  if (!process.env.BASE) {
    kid = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: new URL(BASE).port }, stdio: ['ignore', 'ignore', 'inherit'] });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/health')).ok) break; } catch { /* starting */ } await sleep(100); }
  }
  for (const [name, fn] of tests) {
    try { await fn(); passes++; console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + '\n     ' + (e.stack || e).toString().split('\n').slice(0, 6).join('\n     ')); }
  }
  if (kid) kid.kill();
  console.log(`${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
