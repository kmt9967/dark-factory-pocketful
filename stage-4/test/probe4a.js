'use strict';
// Stage-4 W4a self-tests: refunds (H1, H2, H6), corrections with refunds (H3), I20, I21, I24 and import.
// Run: node stage-4/test/probe4a.js   (spawns stage-4 and stage-3 server.js)
//  or: BASE=<s4> S3BASE=<s3> node stage-4/test/probe4a.js
const { spawn } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');

const rnd = () => 15000 + Math.floor(Math.random() * 900);
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
const U = (h, bal) => ({ id: `u_${h}`, email: `${h}@example.com`, password: 'correct horse', display_name: h, handle: h, balance: bal });
const past = () => new Date(Date.now() - 1500).toISOString().replace('Z', '+00:00');
async function reset(fx, base = BASE) { const r = await call('POST', '/_test/reset', { body: fx, base }); assert.equal(r.status, 204, JSON.stringify(r.body)); }
async function login(h, base = BASE) { const r = await call('POST', '/auth/login', { body: { email: `${h}@example.com`, password: 'correct horse' }, base }); assert.equal(r.status, 200); return r.body.token; }
async function world(users = [U('ada', 10000), U('bob', 2500), U('cy', 500), U('op', 0)], extra = { settlement_operator_ids: ['u_op'] }) {
  await reset({ currency: 'EUR', minor_units: 2, users, ...extra });
  const w = {};
  for (const u of users) w[u.handle] = await login(u.handle);
  return w;
}
const pay = async (t, to, amount, extra = {}) => { const r = await call('POST', '/payments', { token: t, key: k(), body: { to_handle: to, amount, ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; };
const refund = (t, pid, body, key = k()) => call('POST', `/payments/${pid}/refunds`, { token: t, key, body });
const correct = (t, pid, body, key = k()) => call('POST', `/payments/${pid}/corrections`, { token: t, key, body });
const bal = async (t) => (await call('GET', '/me', { token: t })).body;
const err = (r, status, code) => { assert.equal(r.status, status, JSON.stringify(r.body)); if (code) assert.equal(r.body.error.code, code, JSON.stringify(r.body)); };
const tests = [];
const test = (n, f) => tests.push([n, f]);

test('refund shape, direction, replay; other payments carry refund_of: null', async () => {
  const w = await world();
  const p = await pay(w.ada, 'bob', 1000, { note: 'dinner 🍝', visibility: 'private' });
  assert.equal(p.refund_of, null);
  const key = k();
  const r = await refund(w.bob, p.payment_id, { amount: 300 }, key);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const f = r.body;
  assert.equal(f.from_user_id, 'u_bob'); assert.equal(f.to_user_id, 'u_ada');
  assert.equal(f.from_handle, 'bob'); assert.equal(f.to_handle, 'ada');
  assert.equal(f.amount, 300); assert.equal(f.note, 'dinner 🍝'); assert.equal(f.visibility, 'private');
  assert.equal(f.refund_of, p.payment_id);
  assert.equal(f.request_id, null); assert.equal(f.authorization_id, null); assert.equal(f.settlement_id, null);
  assert.ok(Math.abs(Date.parse(f.created_at) - Date.now()) < 5000);
  assert.equal((await bal(w.ada)).balance, 9300); assert.equal((await bal(w.bob)).balance, 3200);
  const again = await refund(w.bob, p.payment_id, { amount: 300 }, key);
  assert.equal(again.status, 200); assert.deepEqual(again.body, f);
  err(await refund(w.bob, p.payment_id, { amount: 301 }, key), 409, 'idempotency_key_reuse');
  assert.equal((await bal(w.bob)).balance, 3200);
  // feed (private: parties only) and statements show the refund with its link
  const feedA = (await call('GET', '/activity', { token: w.ada })).body.payments;
  assert.equal(feedA[0].payment_id, f.payment_id); assert.equal(feedA[0].refund_of, p.payment_id);
  assert.equal(feedA[1].refund_of, null);
  assert.equal((await call('GET', '/activity', { token: w.cy })).body.payments.length, 0);
  const s = (await call('GET', '/statement', { token: w.ada })).body;
  assert.deepEqual(s.entries.map((e) => [e.payment.payment_id, e.delta, e.payment.refund_of]), [[p.payment_id, -1000, null], [f.payment_id, 300, p.payment_id]]);
  assert.equal(s.closing_balance, 9300);
  const revs = (await call('GET', `/payments/${f.payment_id}/revisions`, { token: w.ada })).body.revisions;
  assert.equal(revs.length, 1); assert.equal(revs[0].correction_batch_id, null);
});

test('H1 order and precedence pairs', async () => {
  const w = await world();
  const p = await pay(w.ada, 'bob', 1000);
  err(await call('POST', `/payments/${p.payment_id}/refunds`, { key: k(), body: { amount: 1 } }), 401, 'unauthenticated');
  err(await call('POST', `/payments/${p.payment_id}/refunds`, { token: w.bob, key: k(), raw: '{x' }), 400, 'malformed_request');
  err(await call('POST', `/payments/${p.payment_id}/refunds`, { token: w.bob, body: { amount: 1 } }), 400, 'missing_idempotency_key');
  err(await refund(w.bob, p.payment_id, { amount: 1 }, 'x'.repeat(256)), 422, 'validation_failed');
  err(await refund(w.bob, 'p_nope', { amount: 1 }), 404, 'not_found');
  err(await refund(w.bob, 'p_nope', { amount: 'x' }), 404, 'not_found');
  err(await refund(w.ada, p.payment_id, { amount: 1 }), 403, 'forbidden');
  err(await refund(w.cy, p.payment_id, { amount: 1 }), 403, 'forbidden');
  err(await refund(w.ada, p.payment_id, { amount: 'x' }), 403, 'forbidden');
  for (const a of [0, -1, 1.5, '5', true, null, 1000000001]) err(await refund(w.bob, p.payment_id, { amount: a }), 422, 'validation_failed');
  err(await refund(w.bob, p.payment_id, {}), 422, 'validation_failed');
  err(await refund(w.bob, p.payment_id, { amount: 1001 }), 422, 'refund_exceeds_payment');
  const r = (await refund(w.bob, p.payment_id, { amount: 10 })).body;
  // refund of a refund: the refund's receiver is ada
  err(await refund(w.ada, r.payment_id, { amount: 1 }), 422, 'invalid_refund_target');
  err(await refund(w.ada, r.payment_id, { amount: 0 }), 422, 'validation_failed');
  err(await refund(w.bob, r.payment_id, { amount: 1 }), 403, 'forbidden');
  // exceeds + insufficient -> exceeds; insufficient alone -> 409 (cy holds 500 but receives 400 and spends)
  const q = await pay(w.ada, 'cy', 400); // cy 900
  await pay(w.cy, 'bob', 850); // cy 50
  err(await refund(w.cy, q.payment_id, { amount: 401 }), 422, 'refund_exceeds_payment');
  err(await refund(w.cy, q.payment_id, { amount: 100 }), 409, 'insufficient_funds');
  assert.equal((await refund(w.cy, q.payment_id, { amount: 50 })).status, 201);
  // a failed refund claims no key
  const key = k();
  err(await refund(w.cy, q.payment_id, { amount: 1 }, key), 409, 'insufficient_funds');
  await pay(w.bob, 'cy', 5);
  assert.equal((await refund(w.cy, q.payment_id, { amount: 1 }, key)).status, 201);
});

test('partial refunds sum exactly to the amount; then one more unit -> 422', async () => {
  const w = await world();
  const p = await pay(w.ada, 'bob', 1000);
  for (const a of [100, 250, 400, 250]) assert.equal((await refund(w.bob, p.payment_id, { amount: a })).status, 201);
  err(await refund(w.bob, p.payment_id, { amount: 1 }), 422, 'refund_exceeds_payment');
  assert.equal((await bal(w.ada)).balance, 10000); assert.equal((await bal(w.bob)).balance, 2500);
});

test('available, not total: a hold blocks the refund (409)', async () => {
  const w = await world();
  const p = await pay(w.ada, 'bob', 1000); // bob 3500
  const h = (await call('POST', '/authorizations', { token: w.bob, key: k(), body: { to_handle: 'cy', amount: 3000 } })).body;
  err(await refund(w.bob, p.payment_id, { amount: 501 }), 409, 'insufficient_funds');
  assert.equal((await refund(w.bob, p.payment_id, { amount: 500 })).status, 201);
  const me = await bal(w.bob);
  assert.deepEqual([me.total, me.held, me.available], [3000, 3000, 0]);
  await call('POST', `/authorizations/${h.authorization_id}/void`, { token: w.bob });
  assert.equal((await refund(w.bob, p.payment_id, { amount: 500 })).status, 201);
});

test('request payment, capture and settlement member are refundable; nothing reopens', async () => {
  const w = await world();
  // request payment
  const rq = (await call('POST', '/requests', { token: w.bob, key: k(), body: { payer_handle: 'ada', amount: 700 } })).body;
  const paid = (await call('POST', `/requests/${rq.request_id}/pay`, { token: w.ada, key: k() })).body;
  const r1 = await refund(w.bob, paid.payment_id, { amount: 700 });
  assert.equal(r1.status, 201); assert.equal(r1.body.request_id, null);
  const rqv = (await call('GET', '/requests', { token: w.bob })).body.requests.find((x) => x.request_id === rq.request_id);
  assert.equal(rqv.status, 'paid'); assert.equal(rqv.payment_id, paid.payment_id);
  // capture: authorisation stays captured, the released remainder is not re-held
  const a = (await call('POST', '/authorizations', { token: w.ada, key: k(), body: { to_handle: 'bob', amount: 2000 } })).body;
  const cap = (await call('POST', `/authorizations/${a.authorization_id}/capture`, { token: w.bob, key: k(), body: { amount: 1500 } })).body;
  const r2 = await refund(w.bob, cap.payment_id, { amount: 1500 });
  assert.equal(r2.status, 201); assert.equal(r2.body.authorization_id, null); assert.equal(r2.body.refund_of, cap.payment_id);
  const av = (await call('GET', '/authorizations', { token: w.ada })).body.authorizations.find((x) => x.authorization_id === a.authorization_id);
  assert.equal(av.status, 'captured'); assert.equal(av.captured_amount, 1500); assert.equal(av.remaining_amount, 0);
  assert.equal((await bal(w.ada)).held, 0);
  err(await refund(w.bob, cap.payment_id, { amount: 1 }), 422, 'refund_exceeds_payment');
  // settlement member: refundable, membership unchanged, the refund is not a member
  const st = (await call('POST', '/settlements', { token: w.op, key: k(), body: { transfers: [
    { from_handle: 'ada', to_handle: 'cy', amount: 100 }, { from_handle: 'bob', to_handle: 'cy', amount: 50 }] } })).body;
  const m0 = st.payments[0];
  const r3 = await refund(w.cy, m0.payment_id, { amount: 40 });
  assert.equal(r3.status, 201); assert.equal(r3.body.settlement_id, null);
  const feed = (await call('GET', '/activity', { token: w.cy })).body.payments;
  assert.equal(feed.find((x) => x.payment_id === m0.payment_id).settlement_id, st.settlement_id);
  const replay = await call('POST', '/settlements', { token: w.op, key: 'never-used', body: { transfers: [{ from_handle: 'ada', to_handle: 'cy', amount: 1 }] } });
  assert.equal(replay.status, 201);
  // Σ conserved
  const sum = (await bal(w.ada)).total + (await bal(w.bob)).total + (await bal(w.cy)).total + (await bal(w.op)).total;
  assert.equal(sum, 13000);
});

test('corrections with refunds: limit is the corrected amount; below refunded -> 422; refunds immutable', async () => {
  const w = await world();
  const p = await pay(w.ada, 'bob', 1000);
  assert.equal((await correct(w.ada, p.payment_id, { expected_revision: 1, amount: 600, effective_at: past(), reason: 'overcharged' })).status, 201);
  err(await refund(w.bob, p.payment_id, { amount: 601 }), 422, 'refund_exceeds_payment');
  const r = (await refund(w.bob, p.payment_id, { amount: 400 })).body;
  // a correction below the refunded 400 -> 422; stale + below -> 409 stale (stale first)
  err(await correct(w.ada, p.payment_id, { expected_revision: 2, amount: 399, effective_at: past(), reason: 'x' }), 422, 'refund_exceeds_payment');
  err(await correct(w.ada, p.payment_id, { expected_revision: 1, amount: 399, effective_at: past(), reason: 'x' }), 409, 'stale_revision');
  err(await correct(w.ada, p.payment_id, { expected_revision: 2, amount: -1, effective_at: past(), reason: 'x' }), 422, 'validation_failed');
  assert.equal((await correct(w.ada, p.payment_id, { expected_revision: 2, amount: 400, effective_at: past(), reason: 'x' })).status, 201);
  err(await refund(w.bob, p.payment_id, { amount: 1 }), 422, 'refund_exceeds_payment');
  // correcting the refund itself: its sender is bob
  err(await correct(w.bob, r.payment_id, { expected_revision: 1, amount: 100, effective_at: past(), reason: 'x' }), 422, 'linked_payment_immutable');
  err(await correct(w.bob, r.payment_id, { expected_revision: 9, amount: 100, effective_at: past(), reason: 'x' }), 422, 'linked_payment_immutable');
  err(await correct(w.ada, r.payment_id, { expected_revision: 1, amount: 100, effective_at: past(), reason: 'x' }), 403, 'forbidden');
  const resp = await correct(w.ada, p.payment_id, { expected_revision: 3, amount: 500, effective_at: past(), reason: 'final' });
  assert.equal(resp.status, 201); assert.equal(resp.body.correction_batch_id, null);
  const revs = (await call('GET', `/payments/${p.payment_id}/revisions`, { token: w.bob })).body.revisions;
  assert.ok(revs.every((x) => 'correction_batch_id' in x && x.correction_batch_id === null));
  assert.equal((await bal(w.ada)).balance + (await bal(w.bob)).balance + (await bal(w.cy)).balance, 13000);
});

test('50 concurrent refunds of one payment never exceed it', async () => {
  const w = await world();
  const p = await pay(w.ada, 'bob', 1000);
  const rs = await Promise.all(Array.from({ length: 50 }, () => refund(w.bob, p.payment_id, { amount: 30 })));
  assert.ok(rs.every((r) => r.status < 500));
  assert.equal(rs.filter((r) => r.status === 201).length, 33);
  assert.ok(rs.filter((r) => r.status !== 201).every((r) => r.status === 422 && r.body.error.code === 'refund_exceeds_payment'));
  assert.equal((await bal(w.bob)).balance, 2500 + 1000 - 990);
  // concurrent identical refunds with one key: exactly one 201
  const q = await pay(w.ada, 'bob', 100);
  const key = k();
  const same = await Promise.all(Array.from({ length: 20 }, () => refund(w.bob, q.payment_id, { amount: 60 }, key)));
  assert.equal(same.filter((r) => r.status === 201).length, 1); assert.equal(same.filter((r) => r.status === 200).length, 19);
});

test('I24: recorded_at strictly increases after importing history that ran ahead of this clock', async () => {
  const w = await world();
  const p = await pay(w.ada, 'bob', 1000);
  const c1 = (await correct(w.ada, p.payment_id, { expected_revision: 1, amount: 900, effective_at: past(), reason: 'a' })).body;
  const ex = (await call('GET', '/_test/export')).body;
  // A small lead (2 s): I24 raises the server clock to the chosen instant, which then decays as wall time passes.
  const ahead = new Date(Date.now() + 2000).toISOString().replace('Z', '+00:00');
  ex.state.revisions.find((e) => e[0] === p.payment_id)[1][1].recorded_at = ahead;
  assert.equal((await call('POST', '/_test/import', { body: ex })).status, 204);
  const c2 = (await correct(w.ada, p.payment_id, { expected_revision: 2, amount: 800, effective_at: past(), reason: 'b' })).body;
  assert.ok(Date.parse(c2.recorded_at) > Date.parse(ahead), `${c2.recorded_at} must be after ${ahead}`);
  assert.equal(Date.parse(c2.recorded_at) - Date.parse(ahead), 1);
  void c1;
  await sleep(2100);
});

test('export/import with refunds; I20 and refund-target validation; stage-3 export imports', async () => {
  const w = await world();
  const p = await pay(w.ada, 'bob', 1000);
  const key = k();
  const r = (await refund(w.bob, p.payment_id, { amount: 600 }, key)).body;
  const ex = (await call('GET', '/_test/export')).body;
  await reset({ currency: 'EUR', minor_units: 2, users: [U('zz', 1)] });
  assert.equal((await call('POST', '/_test/import', { body: ex })).status, 204);
  err(await refund(w.bob, p.payment_id, { amount: 401 }), 422, 'refund_exceeds_payment');
  const again = await refund(w.bob, p.payment_id, { amount: 600 }, key);
  assert.equal(again.status, 200); assert.deepEqual(again.body, r);
  const tamper = [
    (s) => { s.payments.find((x) => x.payment_id === r.payment_id).refund_of = 'p_nope'; },
    (s) => { s.payments.find((x) => x.payment_id === r.payment_id).refund_of = r.payment_id; },
    (s) => { const x = s.payments.find((y) => y.payment_id === r.payment_id); x.from_user_id = 'u_ada'; x.from_handle = 'ada'; x.to_user_id = 'u_bob'; x.to_handle = 'bob'; },
    (s) => { s.revisions.find((e) => e[0] === p.payment_id)[1].push({ revision: 2, amount: 500, effective_at: '2026-01-01T00:00:00Z', recorded_at: '2099-01-01T00:00:00Z', reason: 'x', correction_batch_id: null }); },
    (s) => { s.payments.find((x) => x.payment_id === r.payment_id).refund_of = 5; },
  ];
  for (const t of tamper) {
    const bad = JSON.parse(JSON.stringify(ex)); t(bad.state);
    err(await call('POST', '/_test/import', { body: bad }), 422, 'validation_failed');
  }
  assert.equal((await bal(w.bob)).balance, 2900);
  // a real stage-3 export (with a correction) imports: refund_of null, correction_batch_id null, refundable
  await reset({ currency: 'EUR', minor_units: 2, users: [U('ada', 10000), U('bob', 2500)] }, S3BASE);
  const a3 = await login('ada', S3BASE), b3 = await login('bob', S3BASE);
  const p3 = (await call('POST', '/payments', { token: a3, key: k(), body: { to_handle: 'bob', amount: 1000 }, base: S3BASE })).body;
  const c3 = await call('POST', `/payments/${p3.payment_id}/corrections`, { token: a3, key: k(), body: { expected_revision: 1, amount: 700, effective_at: past(), reason: 'fix' }, base: S3BASE });
  assert.equal(c3.status, 201);
  const ex3 = (await call('GET', '/_test/export', { base: S3BASE })).body;
  assert.equal((await call('POST', '/_test/import', { body: ex3 })).status, 204);
  const feed = (await call('GET', '/activity', { token: a3 })).body.payments;
  assert.equal(feed[0].refund_of, null);
  const revs = (await call('GET', `/payments/${p3.payment_id}/revisions`, { token: b3 })).body.revisions;
  assert.deepEqual(revs.map((x) => [x.amount, x.correction_batch_id]), [[1000, null], [700, null]]);
  err(await refund(b3, p3.payment_id, { amount: 701 }), 422, 'refund_exceeds_payment');
  assert.equal((await refund(b3, p3.payment_id, { amount: 700 })).status, 201);
  assert.equal((await bal(a3)).balance, 10000);
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
