'use strict';
// Stage-4 W4b self-tests: POST /correction-batches (H4, H5, I22, I23), concurrency with single
// corrections, snapshots/known_at, export/import incl. a real stage-3 export.
// Run: node stage-4/test/probe4b.js   (spawns stage-4 and stage-3 server.js)
//  or: BASE=<s4> S3BASE=<s3> node stage-4/test/probe4b.js
const { spawn } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');

const rnd = () => 14000 + Math.floor(Math.random() * 900);
const BASE = process.env.BASE || `http://127.0.0.1:${rnd()}`;
const S3BASE = process.env.S3BASE || `http://127.0.0.1:${rnd() + 1000}`;
let failures = 0, passes = 0;
async function call(method, p, { body, raw, token, key, base = BASE } = {}) {
  const h = {};
  if (token) h.authorization = `Bearer ${token}`;
  if (key !== undefined) h['idempotency-key'] = key;
  let payload;
  if (raw !== undefined) payload = raw; else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const r = await fetch(base + p, { method, headers: h, body: payload });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, body: json };
}
const k = () => 'k' + Math.random().toString(36).slice(2) + Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
const U = (h, bal) => ({ id: `u_${h}`, email: `${h}@example.com`, password: 'correct horse', display_name: h, handle: h, balance: bal });
const past = (ms = 1500) => new Date(Date.now() - ms).toISOString().replace('Z', '+00:00');
const plus2h = (iso) => { const d = new Date(Date.parse(iso) + 2 * 3600e3).toISOString().slice(0, 23); return `${d}+02:00`; };
async function reset(fx, base = BASE) { const r = await call('POST', '/_test/reset', { body: fx, base }); assert.equal(r.status, 204, JSON.stringify(r.body)); }
async function login(h, base = BASE) { const r = await call('POST', '/auth/login', { body: { email: `${h}@example.com`, password: 'correct horse' }, base }); assert.equal(r.status, 200); return r.body.token; }
async function world(users = [U('ada', 10000), U('bob', 2500), U('cy', 500), U('op', 0)]) {
  await reset({ currency: 'EUR', minor_units: 2, users, settlement_operator_ids: ['u_op'] });
  const w = {};
  for (const u of users) w[u.handle] = await login(u.handle);
  return w;
}
const pay = async (t, to, amount) => { const r = await call('POST', '/payments', { token: t, key: k(), body: { to_handle: to, amount } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; };
const batch = (t, corrections, key = k(), extra = {}) => call('POST', '/correction-batches', { token: t, key, body: { corrections, ...extra } });
const settle = async (w, transfers) => { const r = await call('POST', '/settlements', { token: w.op, key: k(), body: { transfers } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; };
const I = (pid, er, amount, effective_at, reason = 'batch fix') => ({ payment_id: pid, expected_revision: er, amount, effective_at, reason });
const me = async (t, qs = '') => (await call('GET', '/me' + qs, { token: t })).body;
const err = (r, status, code) => { assert.equal(r.status, status, JSON.stringify(r.body)); if (code) assert.equal(r.body.error.code, code, JSON.stringify(r.body)); };
const tests = [];
const test = (n, f) => tests.push([n, f]);

test('happy path: non-party operator, shape, shared recorded_at, revisions endpoint, replay', async () => {
  const w = await world();
  const p1 = await pay(w.ada, 'bob', 1000);
  const p2 = await pay(w.bob, 'cy', 200);
  const key = k();
  const eff = past(0) < p2.created_at ? p2.created_at : p2.created_at;
  const r = await batch(w.op, [I(p1.payment_id, 1, 800, p1.created_at, 'over'), { ...I(p2.payment_id, 1, 250, eff), extra: 'ignored' }], key, { unknown: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const b = r.body;
  assert.deepEqual(Object.keys(b).sort(), ['correction_batch_id', 'recorded_at', 'revisions']);
  assert.match(b.correction_batch_id, /.+/); assert.ok(b.correction_batch_id.length <= 64);
  assert.deepEqual(b.revisions.map((x) => [x.payment_id, x.revision, x.amount]), [[p1.payment_id, 2, 800], [p2.payment_id, 2, 250]]);
  for (const x of b.revisions) {
    assert.deepEqual(Object.keys(x).sort(), ['amount', 'correction_batch_id', 'effective_at', 'payment_id', 'reason', 'recorded_at', 'revision']);
    assert.equal(x.recorded_at, b.recorded_at); assert.equal(x.correction_batch_id, b.correction_batch_id);
  }
  assert.ok(Date.parse(b.recorded_at) > Date.parse(p2.created_at));
  assert.equal((await me(w.ada)).balance, 9200); assert.equal((await me(w.bob)).balance, 2500 + 800 - 250); assert.equal((await me(w.cy)).balance, 750);
  const revs = (await call('GET', `/payments/${p1.payment_id}/revisions`, { token: w.bob })).body.revisions;
  assert.deepEqual(revs.map((x) => [x.revision, x.correction_batch_id]), [[1, null], [2, b.correction_batch_id]]);
  // the operator is not a party: revisions are still private to the parties
  err(await call('GET', `/payments/${p1.payment_id}/revisions`, { token: w.op }), 404, 'not_found');
  // replay after newer revisions (single correction by the sender) -> 200 original
  assert.equal((await call('POST', `/payments/${p1.payment_id}/corrections`, { token: w.ada, key: k(), body: { expected_revision: 2, amount: 700, effective_at: p1.created_at, reason: 'again' } })).status, 201);
  const again = await batch(w.op, [I(p1.payment_id, 1, 800, p1.created_at, 'over'), { ...I(p2.payment_id, 1, 250, eff), extra: 'ignored' }], key, { unknown: true });
  assert.equal(again.status, 200); assert.deepEqual(again.body, b);
  err(await batch(w.op, [I(p1.payment_id, 1, 801, p1.created_at, 'over')], key), 409, 'idempotency_key_reuse');
  // originals unchanged; activity shows the original amounts
  const feed = (await call('GET', '/activity', { token: w.ada })).body.payments;
  assert.equal(feed.find((x) => x.payment_id === p1.payment_id).amount, 1000);
});

test('H4 auth, shape and item order with precedence pairs', async () => {
  const w = await world();
  const p1 = await pay(w.ada, 'bob', 1000);
  const p2 = await pay(w.ada, 'cy', 100);
  const ok = [I(p1.payment_id, 1, 900, p1.created_at)];
  err(await call('POST', '/correction-batches', { key: k(), body: { corrections: ok } }), 401, 'unauthenticated');
  err(await call('POST', '/correction-batches', { token: w.op, key: k(), raw: '{x' }), 400, 'malformed_request');
  err(await call('POST', '/correction-batches', { token: w.ada, body: { corrections: ok } }), 403, 'forbidden'); // non-operator before key
  err(await batch(w.ada, ok), 403, 'forbidden');
  err(await call('POST', '/correction-batches', { token: w.op, body: { corrections: ok } }), 400, 'missing_idempotency_key');
  err(await batch(w.op, ok, 'x'.repeat(256)), 422, 'validation_failed');
  for (const shape of [undefined, 'x', [], Array.from({ length: 33 }, () => ok[0]), [5], [ok[0], null], [ok[0], { ...ok[0] }]]) {
    err(await call('POST', '/correction-batches', { token: w.op, key: k(), body: shape === undefined ? {} : { corrections: shape } }), 422, 'validation_failed');
  }
  // duplicate check is shape-level: even when the duplicates would otherwise be 404
  err(await batch(w.op, [I('p_x', 1, 1, past()), I('p_x', 1, 1, past())]), 422, 'validation_failed');
  // item errors in input order
  err(await batch(w.op, [I(p1.payment_id, 1, -1, p1.created_at), I('p_nope', 1, 1, past())]), 422, 'validation_failed');
  err(await batch(w.op, [I('p_nope', 1, 1, past()), I(p1.payment_id, 1, -1, p1.created_at)]), 404, 'not_found');
  err(await batch(w.op, [I(p1.payment_id, 2, 900, p1.created_at), I('p_nope', 1, 1, past())]), 409, 'stale_revision');
  err(await batch(w.op, [I(p1.payment_id, 1, 900, p1.created_at), I('p_nope', 1, 1, past())]), 404, 'not_found');
  err(await batch(w.op, [{ ...ok[0], payment_id: 5 }]), 422, 'validation_failed');
  for (const bad of [{ expected_revision: 0 }, { amount: 1.5 }, { amount: '5' }, { reason: '' }, { reason: 'x'.repeat(201) }, { effective_at: '2026-01-01' }, { effective_at: new Date(Date.now() + 60000).toISOString() }]) {
    err(await batch(w.op, [{ ...ok[0], ...bad }]), 422, 'validation_failed');
  }
  // linked: capture and refund -> 422 linked (before stale); refund_exceeds_payment after stale
  const a = (await call('POST', '/authorizations', { token: w.ada, key: k(), body: { to_handle: 'bob', amount: 50 } })).body;
  const cap = (await call('POST', `/authorizations/${a.authorization_id}/capture`, { token: w.bob, key: k(), body: {} })).body;
  err(await batch(w.op, [I(cap.payment_id, 9, 10, past())]), 422, 'linked_payment_immutable');
  const rf = (await call('POST', `/payments/${p2.payment_id}/refunds`, { token: w.cy, key: k(), body: { amount: 60 } })).body;
  err(await batch(w.op, [I(rf.payment_id, 1, 10, past())]), 422, 'linked_payment_immutable');
  err(await batch(w.op, [I(p2.payment_id, 1, 59, p2.created_at)]), 422, 'refund_exceeds_payment');
  err(await batch(w.op, [I(p2.payment_id, 2, 59, p2.created_at)]), 409, 'stale_revision');
  // nothing changed by any rejection
  assert.equal((await me(w.ada)).balance, 10000 - 1000 - 100 + 60 - 50);
  assert.equal((await call('GET', `/payments/${p1.payment_id}/revisions`, { token: w.ada })).body.revisions.length, 1);
});

test('settlements: completeness, identical instants (offset spellings), full reversal, singles stay linked', async () => {
  const w = await world();
  const p0 = await pay(w.ada, 'cy', 100);
  const st = await settle(w, [{ from_handle: 'ada', to_handle: 'bob', amount: 300 }, { from_handle: 'bob', to_handle: 'cy', amount: 200 }, { from_handle: 'ada', to_handle: 'cy', amount: 50 }]);
  const [m1, m2, m3] = st.payments;
  const T = st.committed_at;
  // single correction of a member stays 422 linked; a nonmember single correction is fine
  err(await call('POST', `/payments/${m1.payment_id}/corrections`, { token: w.ada, key: k(), body: { expected_revision: 1, amount: 0, effective_at: T, reason: 'x' } }), 422, 'linked_payment_immutable');
  // incomplete
  err(await batch(w.op, [I(m1.payment_id, 1, 0, T), I(m2.payment_id, 1, 0, T)]), 422, 'incomplete_settlement');
  // an item error beats incompleteness
  err(await batch(w.op, [I(m1.payment_id, 1, 0, T), I(p0.payment_id, 1, -5, T)]), 422, 'validation_failed');
  err(await batch(w.op, [I(m1.payment_id, 1, 0, T), I('p_nope', 1, 0, T)]), 404, 'not_found');
  // incomplete beats differing instants
  err(await batch(w.op, [I(m1.payment_id, 1, 0, T), I(m2.payment_id, 1, 0, past(5000))]), 422, 'incomplete_settlement');
  // differing instants -> 422 validation_failed
  err(await batch(w.op, [I(m1.payment_id, 1, 0, T), I(m2.payment_id, 1, 0, T), I(m3.payment_id, 1, 0, p0.created_at)]), 422, 'validation_failed');
  // identical instant in another offset spelling: full reversal, balances back to before the settlement
  const before = { ada: (await me(w.ada)).balance, bob: (await me(w.bob)).balance, cy: (await me(w.cy)).balance };
  const r = await batch(w.op, [I(m1.payment_id, 1, 0, T, 'reverse'), I(m2.payment_id, 1, 0, plus2h(T), 'reverse'), I(m3.payment_id, 1, 0, T.replace('+00:00', 'Z'), 'reverse')]);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.revisions[1].effective_at, plus2h(T));
  assert.equal((await me(w.ada)).balance, before.ada + 350); assert.equal((await me(w.bob)).balance, before.bob - 300 + 200);
  assert.equal((await me(w.cy)).balance, before.cy - 250);
  assert.equal((await me(w.ada)).balance + (await me(w.bob)).balance + (await me(w.cy)).balance + (await me(w.op)).balance, 13000);
  // membership and the settlement's original retry are unchanged
  const feed = (await call('GET', '/activity', { token: w.ada })).body.payments;
  assert.equal(feed.find((x) => x.payment_id === m1.payment_id).settlement_id, st.settlement_id);
  assert.equal(feed.find((x) => x.payment_id === m1.payment_id).amount, 300);
  // a member can still be refunded; the batch then caps at the refunded amount
  await batch(w.op, [I(m1.payment_id, 2, 300, T), I(m2.payment_id, 2, 200, T), I(m3.payment_id, 2, 50, T)]);
  assert.equal((await call('POST', `/payments/${m1.payment_id}/refunds`, { token: w.bob, key: k(), body: { amount: 120 } })).status, 201);
  err(await batch(w.op, [I(m1.payment_id, 3, 100, T), I(m2.payment_id, 3, 200, T), I(m3.payment_id, 3, 50, T)]), 422, 'refund_exceeds_payment');
});

test('combined affordability: a batch passes where one item alone is unaffordable; insufficient before historical', async () => {
  const w = await world();
  const p1 = await pay(w.cy, 'bob', 500); // cy 0
  await sleep(3);
  const p2 = await pay(w.bob, 'cy', 300); // cy 300
  const E = p2.created_at;
  // alone: +400 on p1 debits cy 400 > available 300
  err(await batch(w.op, [I(p1.payment_id, 1, 900, E)]), 409, 'insufficient_funds');
  err(await call('POST', `/payments/${p1.payment_id}/corrections`, { token: w.cy, key: k(), body: { expected_revision: 1, amount: 900, effective_at: E, reason: 'x' } }), 409, 'insufficient_funds');
  // together with +300 on p2 (credits cy): net -100 <= 300, and at E cy has 500 - 900 + 600 = 200
  const r = await batch(w.op, [I(p1.payment_id, 1, 900, E), I(p2.payment_id, 1, 600, E)]);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await me(w.cy)).balance, 200);
  // insufficient beats historical: both fail -> insufficient
  err(await batch(w.op, [I(p1.payment_id, 2, 5000, '2020-01-01T00:00:00Z')]), 409, 'insufficient_funds');
  // historical only: affordable now, but cy would have paid before receiving anything
  err(await batch(w.op, [I(p1.payment_id, 2, 950, '2020-01-01T00:00:00Z')]), 409, 'historical_overdraft');
  // the same effect split across two items is checked combined: moving p2 later than p1's new time
  err(await batch(w.op, [I(p1.payment_id, 2, 900, p1.created_at), I(p2.payment_id, 2, 600, E)]), 409, 'historical_overdraft');
  assert.equal((await call('GET', `/payments/${p1.payment_id}/revisions`, { token: w.cy })).body.revisions.length, 2);
  assert.equal((await me(w.cy)).balance, 200);
});

test('historical available with a hold, checked across the batch', async () => {
  const w = await world();
  const p = await pay(w.ada, 'cy', 500);
  await sleep(3);
  const a = (await call('POST', '/authorizations', { token: w.ada, key: k(), body: { to_handle: 'bob', amount: 9000 } })).body;
  await sleep(3);
  await call('POST', `/authorizations/${a.authorization_id}/void`, { token: w.ada });
  err(await batch(w.op, [I(p.payment_id, 1, 1200, p.created_at)]), 409, 'historical_overdraft');
  assert.equal((await batch(w.op, [I(p.payment_id, 1, 1000, p.created_at)])).status, 201);
});

test('shared recorded_at is later than every member\'s previous recorded_at, also after an ahead-of-wall import', async () => {
  const w = await world();
  const p1 = await pay(w.ada, 'bob', 1000);
  const p2 = await pay(w.ada, 'bob', 500);
  await call('POST', `/payments/${p2.payment_id}/corrections`, { token: w.ada, key: k(), body: { expected_revision: 1, amount: 400, effective_at: p2.created_at, reason: 'x' } });
  const ex = (await call('GET', '/_test/export')).body;
  const ahead = new Date(Date.now() + 2000).toISOString().replace('Z', '+00:00');
  ex.state.revisions.find((e) => e[0] === p2.payment_id)[1][1].recorded_at = ahead;
  assert.equal((await call('POST', '/_test/import', { body: ex })).status, 204);
  const r = await batch(w.op, [I(p1.payment_id, 1, 900, p1.created_at), I(p2.payment_id, 2, 300, p2.created_at)]);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(Date.parse(r.body.recorded_at) - Date.parse(ahead), 1);
  assert.ok(r.body.revisions.every((x) => x.recorded_at === r.body.recorded_at));
  await sleep(2100);
});

test('snapshots stay frozen; statements and known_at around the batch', async () => {
  const w = await world();
  const p1 = await pay(w.ada, 'bob', 1000);
  const p2 = await pay(w.ada, 'bob', 400);
  const s0 = (await call('GET', '/statement', { token: w.ada })).body;
  const r = (await batch(w.op, [I(p1.payment_id, 1, 0, p1.created_at), I(p2.payment_id, 1, 100, p2.created_at)])).body;
  const before = new Date(Date.parse(r.recorded_at) - 1).toISOString().replace('Z', '+00:00');
  assert.equal((await me(w.ada, `?known_at=${enc(before)}`)).balance, 8600);
  assert.equal((await me(w.ada, `?known_at=${enc(r.recorded_at)}`)).balance, 9900);
  assert.equal((await me(w.ada)).balance, 9900);
  const s1 = (await call('GET', '/statement', { token: w.ada })).body;
  assert.deepEqual(s1.entries.map((e) => [e.payment.amount, e.delta, e.revision, e.recorded_at === r.recorded_at]), [[0, 0, 2, true], [100, -100, 2, true]]);
  const sb = (await call('GET', `/statement?known_at=${enc(before)}`, { token: w.ada })).body;
  assert.deepEqual(sb.entries.map((e) => e.payment.amount), [1000, 400]);
  const frozen = (await call('GET', `/statement?snapshot=${s0.snapshot}`, { token: w.ada })).body;
  assert.deepEqual(frozen.entries, s0.entries); assert.equal(frozen.closing_balance, 8600);
});

test('50 concurrent mixed single and batch corrections on overlapping payments', async () => {
  const w = await world();
  const p1 = await pay(w.ada, 'bob', 1000);
  const p2 = await pay(w.ada, 'bob', 1000);
  const p3 = await pay(w.ada, 'bob', 1000);
  const jobs = [];
  for (let i = 0; i < 50; i++) {
    if (i % 3 === 0) jobs.push(call('POST', `/payments/${p1.payment_id}/corrections`, { token: w.ada, key: k(), body: { expected_revision: 1, amount: 900 - i, effective_at: p1.created_at, reason: 's' } }));
    else if (i % 3 === 1) jobs.push(batch(w.op, [I(p1.payment_id, 1, 800 - i, p1.created_at), I(p2.payment_id, 1, 800 - i, p2.created_at)]));
    else jobs.push(batch(w.op, [I(p2.payment_id, 1, 700 - i, p2.created_at), I(p3.payment_id, 1, 700 - i, p3.created_at)]));
  }
  const rs = await Promise.all(jobs);
  assert.ok(rs.every((r) => r.status < 500), 'no 5xx');
  assert.ok(rs.every((r) => r.status === 201 || (r.status === 409 && r.body.error.code === 'stale_revision')));
  for (const p of [p1, p2, p3]) {
    const revs = (await call('GET', `/payments/${p.payment_id}/revisions`, { token: w.ada })).body.revisions;
    assert.ok(revs.length <= 2, `${p.payment_id} has ${revs.length} revisions`);
  }
  // every success used distinct expected revisions: count of successes touching p1 or p2 is <= 1 each
  const touched = { [p1.payment_id]: 0, [p2.payment_id]: 0, [p3.payment_id]: 0 };
  for (const r of rs.filter((x) => x.status === 201)) {
    const ids = r.body.revisions ? r.body.revisions.map((x) => x.payment_id) : [r.body.payment_id];
    for (const id of ids) touched[id]++;
  }
  assert.ok(Object.values(touched).every((n) => n <= 1), JSON.stringify(touched));
  const t = (await me(w.ada)).balance + (await me(w.bob)).balance + (await me(w.cy)).balance + (await me(w.op)).balance;
  assert.equal(t, 13000);
});

test('export/import with batches; a real stage-3 export imports and its settlement is batch-correctable', async () => {
  const w = await world();
  const p1 = await pay(w.ada, 'bob', 1000);
  const key = k();
  const r = (await batch(w.op, [I(p1.payment_id, 1, 700, p1.created_at)], key)).body;
  const ex = (await call('GET', '/_test/export')).body;
  await reset({ currency: 'EUR', minor_units: 2, users: [U('zz', 1)] });
  assert.equal((await call('POST', '/_test/import', { body: ex })).status, 204);
  const again = await batch(w.op, [I(p1.payment_id, 1, 700, p1.created_at)], key);
  assert.equal(again.status, 200); assert.deepEqual(again.body, r);
  const revs = (await call('GET', `/payments/${p1.payment_id}/revisions`, { token: w.ada })).body.revisions;
  assert.equal(revs[1].correction_batch_id, r.correction_batch_id);
  err(await batch(w.op, [I(p1.payment_id, 1, 600, p1.created_at)]), 409, 'stale_revision');
  const r2 = (await batch(w.op, [I(p1.payment_id, 2, 600, p1.created_at)])).body;
  assert.notEqual(r2.correction_batch_id, r.correction_batch_id);
  const bad = JSON.parse(JSON.stringify(ex)); bad.state.revisions.find((e) => e[0] === p1.payment_id)[1][1].correction_batch_id = 7;
  err(await call('POST', '/_test/import', { body: bad }), 422, 'validation_failed');
  // stage 3 -> stage 4 with a settlement, a correction and a snapshot
  await reset({ currency: 'EUR', minor_units: 2, users: [U('ada', 10000), U('bob', 2500), U('op', 0)], settlement_operator_ids: ['u_op'] }, S3BASE);
  const a3 = await login('ada', S3BASE), o3 = await login('op', S3BASE);
  const st3 = (await call('POST', '/settlements', { token: o3, key: k(), body: { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 100 }, { from_handle: 'bob', to_handle: 'ada', amount: 40 }] }, base: S3BASE })).body;
  const snap3 = (await call('GET', '/statement', { token: a3, base: S3BASE })).body;
  const ex3 = (await call('GET', '/_test/export', { base: S3BASE })).body;
  assert.equal((await call('POST', '/_test/import', { body: ex3 })).status, 204);
  assert.deepEqual((await call('GET', `/statement?snapshot=${snap3.snapshot}`, { token: a3 })).body.entries.map((e) => e.payment.payment_id), snap3.entries.map((e) => e.payment.payment_id));
  const T = st3.committed_at;
  err(await batch(o3, [I(st3.payments[0].payment_id, 1, 0, T)]), 422, 'incomplete_settlement');
  const rr = await batch(o3, [I(st3.payments[0].payment_id, 1, 0, T), I(st3.payments[1].payment_id, 1, 0, T)]);
  assert.equal(rr.status, 201, JSON.stringify(rr.body));
  assert.equal((await me(a3)).balance, 10000);
});

(async () => {
  const kids = [];
  const up = async (base, file) => {
    kids.push(spawn(process.execPath, [file], { env: { ...process.env, PORT: new URL(base).port }, stdio: ['ignore', 'ignore', 'inherit'] }));
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/health')).ok) return; } catch { /* starting */ } await sleep(100); }
  };
  if (!process.env.BASE) await up(BASE, path.join(__dirname, '..', 'server.js'));
  if (!process.env.S3BASE) await up(S3BASE, path.join(__dirname, '..', '..', 'stage-3', 'server.js'));
  for (const [name, fn] of tests) {
    try { await fn(); passes++; console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + '\n     ' + (e.stack || e).toString().split('\n').slice(0, 6).join('\n     ')); }
  }
  for (const c of kids) c.kill();
  console.log(`${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
