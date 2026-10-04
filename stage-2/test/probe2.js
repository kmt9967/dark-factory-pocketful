'use strict';
// Stage-2 API self-tests: authorisations, captures, voids, expiry, available/held, upgrade import.
// Run: node stage-2/test/probe2.js            (spawns stage-2 and stage-1 server.js locally)
//  or: BASE=http://127.0.0.1:P S1_BASE=http://127.0.0.1:Q node stage-2/test/probe2.js  (containers)
const { spawn } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');

const rand = () => 18000 + Math.floor(Math.random() * 1000);
const BASE = process.env.BASE || `http://127.0.0.1:${rand()}`;
const S1_BASE = process.env.S1_BASE || `http://127.0.0.1:${rand() + 1000}`;
let failures = 0, passes = 0;

async function call(method, p, { body, raw, token, key, base = BASE } = {}) {
  const h = {};
  if (token) h.authorization = `Bearer ${token}`;
  if (key !== undefined) h['idempotency-key'] = key;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const r = await fetch(base + p, { method, headers: h, body: payload });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, body: json };
}
const k = () => 'k' + Math.random().toString(36).slice(2) + Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const U = (h, bal, extra = {}) => ({ id: `u_${h}`, email: `${h}@example.com`, password: 'correct horse',
  display_name: h, handle: h, balance: bal, ...extra });
const FX = (extra = {}) => ({ currency: 'EUR', minor_units: 2,
  users: [U('ada', 10000), U('bob', 2500), U('cy', 500)], ...extra });
const isoIn = (sec) => new Date(Date.now() + sec * 1000).toISOString().replace('Z', '+00:00');

async function reset(fx = FX(), base = BASE) {
  const r = await call('POST', '/_test/reset', { body: fx, base });
  assert.equal(r.status, 204, JSON.stringify(r.body));
}
async function login(h, base = BASE) {
  const r = await call('POST', '/auth/login', { body: { email: `${h}@example.com`, password: 'correct horse' }, base });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}
async function world(fx) {
  await reset(fx);
  return { ada: await login('ada'), bob: await login('bob'), cy: await login('cy') };
}
const me = async (t) => (await call('GET', '/me', { token: t })).body;
const err = (r, status, code) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  if (code) assert.equal(r.body.error.code, code, JSON.stringify(r.body));
};
const auth = (t, body, key = k()) => call('POST', '/authorizations', { token: t, key, body });
const capture = (t, id, body, key = k()) => call('POST', `/authorizations/${id}/capture`, { token: t, key, body });
const voidA = (t, id) => call('POST', `/authorizations/${id}/void`, { token: t });
async function conserve(w, total = 13000) {
  let sum = 0;
  for (const t of [w.ada, w.bob, w.cy]) {
    const m = await me(t);
    assert.equal(m.balance, m.total);
    assert.equal(m.available, m.total - m.held);
    assert.ok(m.available >= 0 && m.held >= 0, JSON.stringify(m));
    sum += m.total;
  }
  assert.equal(sum, total);
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('/me has total/available/held; no holds = stage-1 behaviour', async () => {
  const w = await world();
  const m = await me(w.ada);
  assert.deepEqual([m.balance, m.total, m.available, m.held], [10000, 10000, 10000, 0]);
  const p = await call('POST', '/payments', { token: w.ada, key: k(), body: { to_handle: 'bob', amount: 100 } });
  assert.equal(p.status, 201); assert.equal(p.body.authorization_id, null); assert.equal(p.body.settlement_id, null);
  assert.equal((await me(w.ada)).available, 9900);
});

test('create authorisation: shape, ttl, hold, not in feed', async () => {
  const w = await world();
  const r = await auth(w.ada, { to_handle: 'bob', amount: 2000, note: 'deposit', visibility: 'private' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const a = r.body;
  for (const f of ['authorization_id', 'from_user_id', 'from_handle', 'to_user_id', 'to_handle', 'amount', 'captured_amount',
    'remaining_amount', 'currency', 'note', 'visibility', 'status', 'expires_at', 'payment_id', 'payment_ids', 'created_at']) {
    assert.ok(f in a, f);
  }
  assert.equal(a.status, 'open'); assert.equal(a.captured_amount, 0); assert.equal(a.remaining_amount, 2000);
  assert.equal(a.payment_id, null); assert.deepEqual(a.payment_ids, []); assert.equal(a.currency, 'EUR');
  assert.equal(Date.parse(a.expires_at) - Date.parse(a.created_at), 600000);
  assert.ok(/\+00:00$/.test(a.expires_at));
  const m = await me(w.ada);
  assert.deepEqual([m.total, m.available, m.held], [10000, 8000, 2000]);
  assert.equal((await call('GET', '/activity', { token: w.ada })).body.payments.length, 0);
  assert.equal((await call('GET', '/activity', { token: w.bob })).body.payments.length, 0);
  // replay / reuse
  const key = k();
  const r1 = await auth(w.ada, { to_handle: 'cy', amount: 1 }, key);
  const r2 = await auth(w.ada, { amount: 1, to_handle: 'cy' }, key);
  assert.equal(r2.status, 200); assert.deepEqual(r2.body, r1.body);
  err(await auth(w.ada, { to_handle: 'cy', amount: 2 }, key), 409, 'idempotency_key_reuse');
  err(await call('POST', '/authorizations', { token: w.ada, body: { to_handle: 'cy', amount: 1 } }), 400, 'missing_idempotency_key');
  err(await call('POST', '/authorizations', { key: k(), body: { to_handle: 'cy', amount: 1 } }), 401);
});

test('create authorisation errors (E3 order)', async () => {
  const w = await world();
  for (const a of [0, -1, 1.5, '5', true, null, 1000000001]) err(await auth(w.ada, { to_handle: 'bob', amount: a }), 422, 'validation_failed');
  err(await auth(w.ada, { to_handle: 'bob' }), 422, 'validation_failed');
  err(await auth(w.ada, { to_handle: 'bob', amount: 1, note: 'x'.repeat(201) }), 422, 'validation_failed');
  err(await auth(w.ada, { to_handle: 'bob', amount: 1, note: null }), 422, 'validation_failed');
  err(await auth(w.ada, { to_handle: 'bob', amount: 1, visibility: 'friends' }), 422, 'validation_failed');
  err(await auth(w.ada, { to_handle: 'ada', amount: 1 }), 422, 'self_payment');
  err(await auth(w.ada, { to_handle: 'zed', amount: 1 }), 404, 'not_found');
  err(await auth(w.ada, { to_handle: 'BOB', amount: 1 }), 404, 'not_found');
  err(await auth(w.ada, { to_handle: 'BOB', amount: 0 }), 422, 'validation_failed');
  err(await auth(w.ada, { to_handle: 5, amount: 1 }), 400, 'malformed_request');
  err(await auth(w.cy, { to_handle: 'bob', amount: 501 }), 409, 'insufficient_funds');
  assert.equal((await auth(w.cy, { to_handle: 'bob', amount: 300 })).status, 201);
  err(await auth(w.cy, { to_handle: 'bob', amount: 201 }), 409, 'insufficient_funds');
  assert.equal((await auth(w.cy, { to_handle: 'bob', amount: 200 })).status, 201);
  const m = await me(w.cy);
  assert.deepEqual([m.total, m.available, m.held], [500, 0, 500]);
});

test('held funds block payments, request pay and settlements (available)', async () => {
  const w = await world(FX({ settlement_operator_ids: ['u_ada'] }));
  assert.equal((await auth(w.cy, { to_handle: 'bob', amount: 400 })).status, 201);
  err(await call('POST', '/payments', { token: w.cy, key: k(), body: { to_handle: 'bob', amount: 101 } }), 409, 'insufficient_funds');
  const rq = await call('POST', '/requests', { token: w.bob, key: k(), body: { payer_handle: 'cy', amount: 150 } });
  err(await call('POST', `/requests/${rq.body.request_id}/pay`, { token: w.cy, key: k() }), 409, 'insufficient_funds');
  const T = (f, t, amount) => ({ from_handle: f, to_handle: t, amount });
  err(await call('POST', '/settlements', { token: w.ada, key: k(), body: { transfers: [T('cy', 'bob', 101)] } }), 409, 'insufficient_funds');
  // net: cy receives 50 then may send 150
  assert.equal((await call('POST', '/settlements', { token: w.ada, key: k(), body: { transfers: [T('cy', 'bob', 150), T('ada', 'cy', 50)] } })).status, 201);
  const m = await me(w.cy);
  assert.deepEqual([m.total, m.available, m.held], [400, 0, 400]);
  await conserve(w);
});

test('final capture: payment shape, release remainder, second capture 409', async () => {
  const w = await world();
  const a = (await auth(w.ada, { to_handle: 'bob', amount: 2000, note: 'deposit', visibility: 'private' })).body;
  err(await capture(w.ada, a.authorization_id, {}), 403, 'forbidden');
  err(await capture(w.cy, a.authorization_id, {}), 403, 'forbidden');
  err(await capture(w.bob, 'a_nope', {}), 404, 'not_found');
  err(await capture(w.bob, a.authorization_id, { amount: 2001 }), 422, 'capture_exceeds_authorization');
  for (const bad of [0, -5, 1.5, '1', true, null]) err(await capture(w.bob, a.authorization_id, { amount: bad }), 422, 'validation_failed');
  err(await capture(w.bob, a.authorization_id, { amount: 10, final: 'no' }), 400, 'malformed_request');
  err(await capture(w.bob, a.authorization_id, { amount: 10, final: null }), 400, 'malformed_request');
  const key = k();
  const c = await capture(w.bob, a.authorization_id, { amount: 1500 }, key);
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const p = c.body;
  assert.equal(p.amount, 1500); assert.equal(p.authorization_id, a.authorization_id); assert.equal(p.request_id, null);
  assert.equal(p.note, 'deposit'); assert.equal(p.visibility, 'private'); assert.equal(p.from_handle, 'ada'); assert.equal(p.to_handle, 'bob');
  assert.equal(p.settlement_id, null);
  let m = await me(w.ada);
  assert.deepEqual([m.total, m.available, m.held], [8500, 8500, 0]);
  assert.equal((await me(w.bob)).total, 4000);
  const replay = await capture(w.bob, a.authorization_id, { amount: 1500 }, key);
  assert.equal(replay.status, 200); assert.deepEqual(replay.body, p);
  err(await capture(w.bob, a.authorization_id, {}, key), 409, 'idempotency_key_reuse');
  err(await capture(w.bob, a.authorization_id, {}), 409, 'authorization_not_open');
  const list = (await call('GET', '/authorizations', { token: w.ada })).body.authorizations;
  assert.equal(list[0].status, 'captured'); assert.equal(list[0].captured_amount, 1500); assert.equal(list[0].remaining_amount, 0);
  assert.equal(list[0].payment_id, p.payment_id); assert.deepEqual(list[0].payment_ids, [p.payment_id]);
  // in feed per visibility: private → parties only
  assert.ok((await call('GET', '/activity', { token: w.bob })).body.payments.some((x) => x.payment_id === p.payment_id));
  assert.ok(!(await call('GET', '/activity', { token: w.cy })).body.payments.some((x) => x.payment_id === p.payment_id));
  err(await voidA(w.ada, a.authorization_id), 409, 'authorization_not_open');
  await conserve(w);
});

test('default capture amount = remainder; {} vs {"amount":N} differ for replay', async () => {
  const w = await world();
  const a = (await auth(w.ada, { to_handle: 'bob', amount: 700 })).body;
  const key = k();
  const c = await capture(w.bob, a.authorization_id, {}, key);
  assert.equal(c.status, 201); assert.equal(c.body.amount, 700);
  err(await capture(w.bob, a.authorization_id, { amount: 700 }, key), 409, 'idempotency_key_reuse');
  const b = (await auth(w.ada, { to_handle: 'bob', amount: 300 })).body;
  const r = await call('POST', `/authorizations/${b.authorization_id}/capture`, { token: w.bob, key: k() }); // empty body
  assert.equal(r.status, 201); assert.equal(r.body.amount, 300);
});

test('extended capture mode (final:false), void of partial, expiry keeps records', async () => {
  const w = await world();
  const a = (await auth(w.ada, { to_handle: 'bob', amount: 2000 })).body;
  const c1 = await capture(w.bob, a.authorization_id, { amount: 700, final: false });
  assert.equal(c1.status, 201);
  let m = await me(w.ada);
  assert.deepEqual([m.total, m.available, m.held], [9300, 8000, 1300]);
  let v = (await call('GET', '/authorizations', { token: w.bob })).body.authorizations[0];
  assert.equal(v.status, 'open'); assert.equal(v.captured_amount, 700); assert.equal(v.remaining_amount, 1300);
  err(await capture(w.bob, a.authorization_id, { amount: 1301, final: false }), 422, 'capture_exceeds_authorization');
  const c2 = await capture(w.bob, a.authorization_id, { amount: 300, final: false });
  v = (await call('GET', '/authorizations', { token: w.bob })).body.authorizations[0];
  assert.deepEqual(v.payment_ids, [c1.body.payment_id, c2.body.payment_id]); assert.equal(v.payment_id, c2.body.payment_id);
  assert.equal(v.captured_amount, 1000);
  // void releases only the remainder, keeps captures
  const vd = await voidA(w.ada, a.authorization_id);
  assert.equal(vd.status, 200); assert.equal(vd.body.status, 'voided'); assert.equal(vd.body.captured_amount, 1000);
  assert.equal(vd.body.remaining_amount, 0); assert.equal(vd.body.payment_ids.length, 2);
  m = await me(w.ada);
  assert.deepEqual([m.total, m.available, m.held], [9000, 9000, 0]);
  assert.equal((await voidA(w.ada, a.authorization_id)).status, 200);
  err(await capture(w.bob, a.authorization_id, {}), 409, 'authorization_not_open');
  // capturing the entire remainder with final:false closes it
  const b = (await auth(w.ada, { to_handle: 'bob', amount: 500 })).body;
  await capture(w.bob, b.authorization_id, { amount: 200, final: false });
  const c3 = await capture(w.bob, b.authorization_id, { amount: 300, final: false });
  assert.equal(c3.status, 201);
  const vb = (await call('GET', '/authorizations?status=captured', { token: w.ada })).body.authorizations;
  assert.ok(vb.some((x) => x.authorization_id === b.authorization_id && x.remaining_amount === 0));
  // final:true partial releases the rest
  const d = (await auth(w.ada, { to_handle: 'bob', amount: 500 })).body;
  await capture(w.bob, d.authorization_id, { amount: 100, final: false });
  await capture(w.bob, d.authorization_id, { amount: 100, final: true });
  m = await me(w.ada);
  assert.equal(m.held, 0);
  await conserve(w);
});

test('void rules (E2)', async () => {
  const w = await world();
  const a = (await auth(w.ada, { to_handle: 'bob', amount: 1000 })).body;
  err(await voidA(w.bob, a.authorization_id), 403, 'forbidden');
  err(await voidA(w.cy, a.authorization_id), 403, 'forbidden');
  err(await voidA(w.ada, 'a_nope'), 404, 'not_found');
  err(await call('POST', `/authorizations/${a.authorization_id}/void`, {}), 401);
  const v = await voidA(w.ada, a.authorization_id);
  assert.equal(v.status, 200); assert.equal(v.body.status, 'voided'); assert.equal(v.body.remaining_amount, 0);
  assert.equal((await me(w.ada)).available, 10000);
  assert.deepEqual((await voidA(w.ada, a.authorization_id)).body, v.body);
});

test('list filters, privacy, pagination, 422s', async () => {
  const w = await world();
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await auth(w.ada, { to_handle: 'bob', amount: 10 + i })).body.authorization_id);
  ids.push((await auth(w.bob, { to_handle: 'ada', amount: 5 })).body.authorization_id);
  const all = (await call('GET', '/authorizations', { token: w.ada })).body;
  assert.deepEqual(all.authorizations.map((x) => x.authorization_id), [...ids].reverse()); assert.equal(all.has_more, false);
  assert.equal((await call('GET', '/authorizations?direction=outgoing', { token: w.ada })).body.authorizations.length, 3);
  assert.equal((await call('GET', '/authorizations?direction=incoming', { token: w.ada })).body.authorizations.length, 1);
  assert.equal((await call('GET', '/authorizations', { token: w.cy })).body.authorizations.length, 0);
  const pg = (await call('GET', '/authorizations?limit=2&offset=1', { token: w.ada })).body;
  assert.equal(pg.authorizations.length, 2); assert.equal(pg.has_more, true);
  for (const q of ['direction=x', 'status=pending', 'limit=0', 'limit=201', 'limit=1e9', 'offset=-1', 'limit=4.0', 'limit=+4']) {
    err(await call('GET', `/authorizations?${q}`, { token: w.ada }), 422, 'validation_failed');
  }
  err(await call('GET', '/authorizations'), 401);
  err(await call('DELETE', '/authorizations'), 405);
});

test('expiry by clock (ttl 2 s): status expired, hold released, capture 409, void 409', async () => {
  const w = await world(FX({ authorization_ttl_seconds: 2 }));
  const a = (await auth(w.ada, { to_handle: 'bob', amount: 3000 })).body;
  const b = (await auth(w.ada, { to_handle: 'bob', amount: 1000 })).body;
  assert.equal(Date.parse(a.expires_at) - Date.parse(a.created_at), 2000);
  await capture(w.bob, b.authorization_id, { amount: 400, final: false });
  assert.equal((await me(w.ada)).held, 3600);
  await sleep(2300);
  const m = await me(w.ada);
  assert.deepEqual([m.total, m.available, m.held], [9600, 9600, 0]);
  const exp = (await call('GET', '/authorizations?status=expired', { token: w.ada })).body.authorizations;
  assert.equal(exp.length, 2);
  const eb = exp.find((x) => x.authorization_id === b.authorization_id);
  assert.equal(eb.captured_amount, 400); assert.equal(eb.remaining_amount, 0); assert.equal(eb.payment_ids.length, 1);
  assert.equal((await call('GET', '/authorizations?status=open', { token: w.ada })).body.authorizations.length, 0);
  err(await capture(w.bob, a.authorization_id, {}), 409, 'authorization_expired');
  err(await voidA(w.ada, a.authorization_id), 409, 'authorization_not_open');
  // available funds can now be spent
  assert.equal((await call('POST', '/payments', { token: w.ada, key: k(), body: { to_handle: 'cy', amount: 9600 } })).status, 201);
  await conserve(w);
});

test('fixture: ttl validation, seeded holds, 422 cases leave state unchanged', async () => {
  const w = await world();
  const bad = [
    { authorization_ttl_seconds: 0 }, { authorization_ttl_seconds: -5 }, { authorization_ttl_seconds: 1.5 },
    { authorization_ttl_seconds: '600' }, { authorization_ttl_seconds: true }, { authorization_ttl_seconds: null },
    { authorizations: [{ id: 'a_1', from_user_id: 'u_cy', to_user_id: 'u_bob', amount: 501, status: 'open', expires_at: isoIn(7200) }] },
    { authorizations: [{ id: 'a_1', from_user_id: 'u_cy', to_user_id: 'u_bob', amount: 300, status: 'open', expires_at: isoIn(7200) },
      { id: 'a_2', from_user_id: 'u_cy', to_user_id: 'u_ada', amount: 201, status: 'open', expires_at: isoIn(7200) }] },
    { authorizations: [{ id: 'a_1', from_user_id: 'u_cy', to_user_id: 'u_bob', amount: 10, status: 'weird', expires_at: isoIn(7200) }] },
    { authorizations: [{ id: 'a_1', from_user_id: 'u_cy', to_user_id: 'u_zz', amount: 10, status: 'open', expires_at: isoIn(7200) }] },
    { authorizations: [{ id: 'a_1', from_user_id: 'u_cy', to_user_id: 'u_bob', amount: 10, status: 'open', expires_at: 'tomorrow' }] },
    { authorizations: [{ id: 'a_1', from_user_id: 'u_cy', to_user_id: 'u_bob', amount: 10, status: 'open' }] },
    { authorizations: [{ id: 'a_1', from_user_id: 'u_cy', to_user_id: 'u_bob', amount: 0, status: 'open', expires_at: isoIn(7200) }] },
    { authorizations: 'x' },
  ];
  for (const b of bad) err(await call('POST', '/_test/reset', { body: FX(b) }), 422, 'validation_failed');
  assert.equal((await me(w.ada)).total, 10000); // unchanged, old token still works
  // 1000.0 ttl accepted; an expired open hold over the balance is fine (holds nothing)
  await reset(FX({
    authorization_ttl_seconds: 600.0, settlement_operator_ids: [],
    authorizations: [
      { id: 'a_1', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 2000, note: 'deposit', visibility: 'public', status: 'open', expires_at: isoIn(7200) },
      { id: 'a_2', from_user_id: 'u_cy', to_user_id: 'u_bob', amount: 9999, status: 'open', expires_at: isoIn(-7200) },
      { id: 'a_3', from_user_id: 'u_cy', to_user_id: 'u_ada', amount: 9999, status: 'captured', expires_at: isoIn(7200) },
      { id: 'a_4', from_user_id: 'u_cy', to_user_id: 'u_ada', amount: 400, status: 'open', expires_at: '2099-01-01T10:00:00+02:00' },
      { id: 'a_5', from_user_id: 'u_bob', to_user_id: 'u_ada', amount: 100, status: 'voided', expires_at: isoIn(7200) },
    ],
  }));
  const ada = await login('ada'), bob = await login('bob'), cy = await login('cy');
  let m = await me(ada);
  assert.deepEqual([m.total, m.available, m.held], [10000, 8000, 2000]);
  m = await me(cy);
  assert.deepEqual([m.total, m.available, m.held], [500, 100, 400]);
  const l = (await call('GET', '/authorizations', { token: cy })).body.authorizations;
  const byId = Object.fromEntries(l.map((x) => [x.authorization_id, x]));
  assert.equal(byId.a_2.status, 'expired'); assert.equal(byId.a_3.status, 'captured'); assert.equal(byId.a_4.status, 'open');
  assert.equal(byId.a_4.expires_at, '2099-01-01T10:00:00+02:00');
  // seeded hold capturable by receiver
  const c = await capture(bob, 'a_1', { amount: 500 });
  assert.equal(c.status, 201); assert.equal(c.body.note, 'deposit');
  err(await capture(bob, 'a_2', {}), 409, 'authorization_expired');
  err(await capture(ada, 'a_3', {}), 409, 'authorization_not_open');
  err(await capture(ada, 'a_5', {}), 409, 'authorization_not_open');
  // new ids do not collide with seeded ones
  const n = await auth(ada, { to_handle: 'bob', amount: 1 });
  assert.ok(!['a_1', 'a_2', 'a_3', 'a_4', 'a_5'].includes(n.body.authorization_id));
});

test('concurrency: 50 captures/voids/payments against one hold keep I9-I11, no 5xx', async () => {
  for (let round = 0; round < 3; round++) {
    const w = await world();
    const a = (await auth(w.cy, { to_handle: 'bob', amount: 400 })).body;
    const jobs = [];
    for (let i = 0; i < 50; i++) {
      const kind = i % 5;
      if (kind === 0) jobs.push(capture(w.bob, a.authorization_id, { amount: 60, final: false }));
      else if (kind === 1) jobs.push(capture(w.bob, a.authorization_id, { amount: 50 }));
      else if (kind === 2) jobs.push(voidA(w.cy, a.authorization_id));
      else if (kind === 3) jobs.push(call('POST', '/payments', { token: w.cy, key: k(), body: { to_handle: 'ada', amount: 30 } }));
      else jobs.push(auth(w.cy, { to_handle: 'ada', amount: 20 }));
    }
    const rs = await Promise.all(jobs);
    assert.ok(rs.every((r) => r.status < 500), JSON.stringify(rs.filter((r) => r.status >= 500)));
    const v = (await call('GET', '/authorizations?direction=outgoing', { token: w.cy })).body.authorizations.find((x) => x.authorization_id === a.authorization_id);
    assert.ok(v.captured_amount <= 400);
    const captures = rs.filter((r) => r.status === 201 && r.body.authorization_id === a.authorization_id);
    assert.equal(captures.reduce((s, r) => s + r.body.amount, 0), v.captured_amount);
    assert.ok(v.status !== 'open' || v.remaining_amount === 400 - v.captured_amount);
    await conserve(w);
  }
  // identical concurrent captures with one key → one 201, rest 200
  const w = await world();
  const a = (await auth(w.ada, { to_handle: 'bob', amount: 1000 })).body;
  const key = k();
  const rs = await Promise.all(Array.from({ length: 50 }, () => capture(w.bob, a.authorization_id, { amount: 100, final: false }, key)));
  assert.equal(rs.filter((r) => r.status === 201).length, 1);
  assert.equal(rs.filter((r) => r.status === 200).length, 49);
  assert.equal((await me(w.bob)).total, 2600);
  // 50 concurrent distinct-key auths against available
  const rs2 = await Promise.all(Array.from({ length: 50 }, () => auth(w.cy, { to_handle: 'ada', amount: 30 })));
  assert.equal(rs2.filter((r) => r.status === 201).length, 16);
  assert.equal((await me(w.cy)).available, 20);
  await conserve(w);
});

test('export/import preserves authorisations, ttl and retries', async () => {
  const w = await world(FX({ authorization_ttl_seconds: 900 }));
  const a = (await auth(w.ada, { to_handle: 'bob', amount: 2000 })).body;
  const key = k();
  const c = await capture(w.bob, a.authorization_id, { amount: 500, final: false }, key);
  const ex = (await call('GET', '/_test/export')).body;
  assert.ok(Array.isArray(ex.state.authorizations));
  await reset(FX({ users: [U('zz', 1)] }));
  assert.equal((await call('POST', '/_test/import', { body: ex })).status, 204);
  assert.equal((await call('POST', '/_test/import', { body: ex })).status, 204);
  const m = await me(w.ada);
  assert.deepEqual([m.total, m.available, m.held], [9500, 8000, 1500]);
  const r = await capture(w.bob, a.authorization_id, { amount: 500, final: false }, key);
  assert.equal(r.status, 200); assert.deepEqual(r.body, c.body);
  const n = await auth(w.ada, { to_handle: 'bob', amount: 1 });
  assert.equal(Date.parse(n.body.expires_at) - Date.parse(n.body.created_at), 900000);
  assert.notEqual(n.body.authorization_id, a.authorization_id);
  const bad = JSON.parse(JSON.stringify(ex)); bad.state.authorizations = [{ id: 'x' }];
  err(await call('POST', '/_test/import', { body: bad }), 422, 'validation_failed');
  assert.equal((await me(w.ada)).held, 1501); // 1500 imported + the 1-unit hold made after import
});

test('upgrade: stage-1 export imports into stage-2 (tokens, retries, pending requests)', async () => {
  await reset(FX({ settlement_operator_ids: ['u_ada'] }), S1_BASE);
  const ada = await login('ada', S1_BASE), bob = await login('bob', S1_BASE);
  const key = k();
  const p = await call('POST', '/payments', { token: ada, key, body: { to_handle: 'bob', amount: 250 }, base: S1_BASE });
  assert.equal(p.status, 201);
  assert.ok(!('authorization_id' in p.body));
  const rq = await call('POST', '/requests', { token: bob, key: k(), body: { payer_handle: 'ada', amount: 100 }, base: S1_BASE });
  const sk = k();
  const st = await call('POST', '/settlements', { token: ada, key: sk, body: { transfers: [{ from_handle: 'bob', to_handle: 'cy', amount: 5 }] }, base: S1_BASE });
  const ex = (await call('GET', '/_test/export', { base: S1_BASE })).body;
  assert.ok(!('authorizations' in ex.state));
  await reset(FX());
  assert.equal((await call('POST', '/_test/import', { body: ex })).status, 204);
  const m = await me(ada);
  assert.deepEqual([m.balance, m.total, m.available, m.held], [9750, 9750, 9750, 0]);
  const r = await call('POST', '/payments', { token: ada, key, body: { to_handle: 'bob', amount: 250 } });
  assert.equal(r.status, 200); assert.deepEqual(r.body, p.body); // original stage-1 body verbatim
  const r2 = await call('POST', '/settlements', { token: ada, key: sk, body: { transfers: [{ from_handle: 'bob', to_handle: 'cy', amount: 5 }] } });
  assert.equal(r2.status, 200); assert.deepEqual(r2.body, st.body);
  const pay = await call('POST', `/requests/${rq.body.request_id}/pay`, { token: ada, key: k() });
  assert.equal(pay.status, 201); assert.equal(pay.body.authorization_id, null);
  const feed = (await call('GET', '/activity', { token: ada })).body.payments;
  assert.ok(feed.every((x) => x.authorization_id === null));
  const na = await auth(ada, { to_handle: 'bob', amount: 100 });
  assert.equal(na.status, 201);
  assert.equal(Date.parse(na.body.expires_at) - Date.parse(na.body.created_at), 600000);
  assert.equal((await call('POST', '/auth/login', { body: { email: 'bob@example.com', password: 'correct horse' } })).status, 200);
});

test('W2a F1: open hold with nothing remaining is rejected (fixture and import), never a 0 payment', async () => {
  const fx = { currency: 'EUR', minor_units: 2, users: [U('ada', 100), U('bob', 0)] };
  await reset(fx);
  const ada = await login('ada');
  const before = await me(ada);
  for (const captured of [50, 60]) {
    err(await call('POST', '/_test/reset', { body: { ...fx, authorizations: [{ id: 'a1', from_user_id: 'u_ada', to_user_id: 'u_bob',
      amount: 50, status: 'open', captured_amount: captured, expires_at: isoIn(7200) }] } }), 422, 'validation_failed');
  }
  assert.deepEqual(await me(ada), before); // unchanged, old token valid
  // captured with captured_amount == amount is still fine
  await reset({ ...fx, authorizations: [{ id: 'a1', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 50, status: 'captured', captured_amount: 50, expires_at: isoIn(7200) }] });
  const ex = (await call('GET', '/_test/export')).body;
  const bad = JSON.parse(JSON.stringify(ex));
  bad.state.authorizations[0].status = 'open';
  err(await call('POST', '/_test/import', { body: bad }), 422, 'validation_failed');
  const bob = await login('bob');
  err(await capture(bob, 'a1', {}), 409, 'authorization_not_open');
  assert.equal((await call('GET', '/activity', { token: bob })).body.payments.length, 0);
});

test('W2a F2: import rejects open holds above a balance, destination unchanged', async () => {
  await reset({ currency: 'EUR', minor_units: 2, users: [U('ada', 100), U('bob', 0)] });
  const ada = await login('ada');
  const ex = (await call('GET', '/_test/export')).body;
  const mk = (amount, exp) => ({ id: 'a9', from_user_id: 'u_ada', to_user_id: 'u_bob', amount, captured_amount: 0, payment_ids: [],
    note: '', visibility: 'public', status: 'open', expires_at: exp, created_at: isoIn(0) });
  const bad = JSON.parse(JSON.stringify(ex)); bad.state.authorizations = [mk(5000, isoIn(7200))];
  err(await call('POST', '/_test/import', { body: bad }), 422, 'validation_failed');
  let m = await me(ada);
  assert.deepEqual([m.total, m.available, m.held], [100, 100, 0]);
  const two = JSON.parse(JSON.stringify(ex));
  two.state.authorizations = [mk(60, isoIn(7200)), { ...mk(41, isoIn(7200)), id: 'a10' }];
  err(await call('POST', '/_test/import', { body: two }), 422, 'validation_failed');
  // other E4 field rules apply to imported authorisations too
  for (const patch of [{ note: 'x'.repeat(201) }, { payment_ids: [''] }, { payment_ids: ['p'.repeat(65)] }, { expires_at: '2099-01-01T00:00:00' },
    { amount: 0 }, { captured_amount: -1 }, { status: 'weird' }, { visibility: 'friends' }, { to_user_id: 'u_ada' }]) {
    const b = JSON.parse(JSON.stringify(ex)); b.state.authorizations = [{ ...mk(10, isoIn(7200)), ...patch }];
    err(await call('POST', '/_test/import', { body: b }), 422, 'validation_failed');
  }
  const neg = JSON.parse(JSON.stringify(ex)); neg.state.users[0].balance = -1;
  err(await call('POST', '/_test/import', { body: neg }), 422, 'validation_failed');
  // an expired hold above the balance holds nothing, and exactly the balance is allowed
  const ok = JSON.parse(JSON.stringify(ex));
  ok.state.authorizations = [mk(5000, isoIn(-7200)), { ...mk(100, isoIn(7200)), id: 'a10' }];
  assert.equal((await call('POST', '/_test/import', { body: ok })).status, 204);
  m = await me(ada);
  assert.deepEqual([m.total, m.available, m.held], [100, 0, 100]);
});

(async () => {
  const kids = [];
  const up = async (base, file) => {
    const port = new URL(base).port;
    kids.push(spawn(process.execPath, [file], { env: { ...process.env, PORT: port }, stdio: ['ignore', 'ignore', 'inherit'] }));
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/health')).ok) return; } catch { /* not up */ }
      await sleep(100);
    }
  };
  if (!process.env.BASE) await up(BASE, path.join(__dirname, '..', 'server.js'));
  if (!process.env.S1_BASE) await up(S1_BASE, path.join(__dirname, '..', '..', 'stage-1', 'server.js'));
  for (const [name, fn] of tests) {
    try { await fn(); passes++; console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + '\n     ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n     ')); }
  }
  for (const c of kids) c.kill();
  console.log(`${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
