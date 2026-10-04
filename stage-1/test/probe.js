'use strict';
// Self-tests for hidden-spec behaviour. Starts server.js on a free port and probes it.
// Run: node stage-1/test/probe.js
const { spawn } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0, passes = 0;

async function call(method, p, { body, raw, token, key, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (key !== undefined) h['idempotency-key'] = key;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const r = await fetch(BASE + p, { method, headers: h, body: payload });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, body: json, ctype: r.headers.get('content-type') };
}
const k = () => 'k' + Math.random().toString(36).slice(2);
const U = (h, bal, extra = {}) => ({ id: `u_${h}`, email: `${h}@example.com`, password: 'correct horse',
  display_name: h, handle: h, balance: bal, ...extra });
const FX = (extra = {}) => ({ currency: 'EUR', minor_units: 2,
  users: [U('ada', 10000), U('bob', 2500), U('cy', 500)], ...extra });

async function reset(fx = FX()) {
  const r = await call('POST', '/_test/reset', { body: fx });
  assert.equal(r.status, 204, JSON.stringify(r.body));
}
async function login(h) {
  const r = await call('POST', '/auth/login', { body: { email: `${h}@example.com`, password: 'correct horse' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}
async function world(fx) {
  await reset(fx);
  return { ada: await login('ada'), bob: await login('bob'), cy: await login('cy') };
}
const bal = async (t) => (await call('GET', '/me', { token: t })).body.balance;
const err = (r, status, code) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  if (code) assert.equal(r.body.error.code, code);
};

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('health + content type', async () => {
  const r = await call('GET', '/health');
  assert.equal(r.status, 200); assert.deepEqual(r.body, { status: 'ok' });
  assert.equal(r.ctype, 'application/json; charset=utf-8');
});

test('amount forms and typing', async () => {
  const w = await world();
  for (const a of ['1000', true, 0, 1.5, -1, 1000000001, null]) {
    err(await call('POST', '/payments', { token: w.ada, key: k(), body: { to_handle: 'bob', amount: a } }), 422, 'validation_failed');
  }
  const r = await call('POST', '/payments', { token: w.ada, key: k(), raw: '{"to_handle":"bob","amount":1e3}' });
  assert.equal(r.status, 201); assert.equal(r.body.amount, 1000);
  const r2 = await call('POST', '/payments', { token: w.ada, key: k(), raw: '{"to_handle":"bob","amount":1000.0}' });
  assert.equal(r2.status, 201);
  err(await call('POST', '/payments', { token: w.ada, key: k(), body: { to_handle: 5, amount: 1 } }), 400, 'malformed_request');
  err(await call('POST', '/payments', { token: w.ada, key: k(), body: { amount: 1 } }), 422, 'validation_failed');
  err(await call('POST', '/payments', { token: w.ada, key: k(), body: { to_handle: 'bob', amount: 1, note: null } }), 422);
  err(await call('POST', '/payments', { token: w.ada, key: k(), body: { to_handle: 'bob', amount: 1, visibility: 'friends' } }), 422);
  err(await call('POST', '/payments', { token: w.ada, key: k(), body: { to_handle: 'bob', amount: 1, note: 'x'.repeat(201) } }), 422);
  assert.equal((await call('POST', '/payments', { token: w.ada, key: k(), body: { to_handle: 'bob', amount: 1, note: '😀'.repeat(200) } })).status, 201);
  err(await call('POST', '/payments', { token: w.ada, key: k(), body: { to_handle: 'ada', amount: 1 } }), 422, 'self_payment');
  err(await call('POST', '/payments', { token: w.ada, key: k(), body: { to_handle: 'zed', amount: 1 } }), 404, 'not_found');
  err(await call('POST', '/payments', { token: w.cy, key: k(), body: { to_handle: 'bob', amount: 501 } }), 409, 'insufficient_funds');
  err(await call('POST', '/payments', { token: w.ada, key: k(), raw: '{bad' }), 400, 'malformed_request');
  err(await call('POST', '/payments', { token: w.ada, key: k(), raw: '[1]' }), 400, 'malformed_request');
  err(await call('POST', '/payments', { token: w.ada, body: { to_handle: 'bob', amount: 1 } }), 400, 'missing_idempotency_key');
  err(await call('POST', '/payments', { token: w.ada, key: 'x'.repeat(256), body: { to_handle: 'bob', amount: 1 } }), 422);
  err(await call('POST', '/payments', { key: k(), body: { to_handle: 'bob', amount: 1 } }), 401, 'unauthenticated');
  err(await call('POST', '/payments', { token: 'nope', key: k(), body: { to_handle: 'bob', amount: 1 } }), 401);
});

test('note verbatim', async () => {
  const w = await world();
  const note = '  héllo <b>&amp;</b> 👩‍👩‍👧 \n\t ';
  const r = await call('POST', '/payments', { token: w.ada, key: k(), body: { to_handle: 'bob', amount: 1, note } });
  assert.equal(r.body.note, note);
  const a = await call('GET', '/activity', { token: w.bob });
  assert.equal(a.body.payments[0].note, note);
});

test('idempotency semantics', async () => {
  const w = await world();
  const key = k();
  const body = { to_handle: 'bob', amount: 100, note: 'n' };
  const r1 = await call('POST', '/payments', { token: w.ada, key, body });
  assert.equal(r1.status, 201);
  const r2 = await call('POST', '/payments', { token: w.ada, key, raw: '{ "note":"n", "amount":100, "to_handle":"bob" }' });
  assert.equal(r2.status, 200); assert.deepEqual(r2.body, r1.body);
  err(await call('POST', '/payments', { token: w.ada, key, body: { ...body, amount: 101 } }), 409, 'idempotency_key_reuse');
  err(await call('POST', '/payments', { token: w.ada, key, body: { to_handle: 'bob', amount: 'bad' } }), 409, 'idempotency_key_reuse');
  assert.equal(await bal(w.ada), 9900);
  // same key different path: new request
  const r3 = await call('POST', '/requests', { token: w.ada, key, body: { payer_handle: 'bob', amount: 5 } });
  assert.equal(r3.status, 201);
  // same key other user independent
  assert.equal((await call('POST', '/payments', { token: w.bob, key, body: { to_handle: 'ada', amount: 1 } })).status, 201);
  // failed key reusable
  const fk = k();
  err(await call('POST', '/payments', { token: w.cy, key: fk, body: { to_handle: 'bob', amount: 9999 } }), 409, 'insufficient_funds');
  assert.equal((await call('POST', '/payments', { token: w.cy, key: fk, body: { to_handle: 'bob', amount: 1 } })).status, 201);
});

test('concurrent identical idempotent requests', async () => {
  const w = await world();
  const key = k();
  const rs = await Promise.all(Array.from({ length: 40 }, () =>
    call('POST', '/payments', { token: w.ada, key, body: { to_handle: 'bob', amount: 100 } })));
  assert.equal(rs.filter((r) => r.status === 201).length, 1);
  assert.equal(rs.filter((r) => r.status === 200).length, 39);
  for (const r of rs) assert.deepEqual(r.body, rs[0].body);
  assert.equal(await bal(w.ada), 9900);
});

test('concurrent overspend burst', async () => {
  const w = await world();
  const rs = await Promise.all(Array.from({ length: 50 }, () =>
    call('POST', '/payments', { token: w.cy, key: k(), body: { to_handle: 'bob', amount: 30 } })));
  assert.equal(rs.filter((r) => r.status === 201).length, 16);
  assert.ok(rs.every((r) => r.status === 201 || (r.status === 409 && r.body.error.code === 'insufficient_funds')));
  assert.equal(await bal(w.cy), 20);
  assert.equal((await bal(w.ada)) + (await bal(w.bob)) + (await bal(w.cy)), 13000);
});

test('request lifecycle + pay', async () => {
  const w = await world();
  const r = await call('POST', '/requests', { token: w.bob, key: k(), body: { payer_handle: 'cy', amount: 1200, note: 'taxi' } });
  assert.equal(r.status, 201); assert.equal(r.body.status, 'pending'); assert.equal(r.body.payment_id, null);
  const id = r.body.request_id;
  err(await call('POST', `/requests/${id}/pay`, { token: w.bob, key: k() }), 403, 'forbidden');
  err(await call('POST', `/requests/${id}/pay`, { token: w.ada, key: k() }), 403, 'forbidden');
  err(await call('POST', '/requests/nope/pay', { token: w.cy, key: k() }), 404);
  const key = k();
  err(await call('POST', `/requests/${id}/pay`, { token: w.cy, key }), 409, 'insufficient_funds');
  await call('POST', '/payments', { token: w.ada, key: k(), body: { to_handle: 'cy', amount: 1000 } });
  const p = await call('POST', `/requests/${id}/pay`, { token: w.cy, key, body: { visibility: 'private' } });
  assert.equal(p.status, 201); assert.equal(p.body.request_id, id); assert.equal(p.body.visibility, 'private');
  assert.equal(p.body.settlement_id, null);
  const p2 = await call('POST', `/requests/${id}/pay`, { token: w.cy, key, body: { visibility: 'private' } });
  assert.equal(p2.status, 200); assert.deepEqual(p2.body, p.body);
  err(await call('POST', `/requests/${id}/pay`, { token: w.cy, key, body: {} }), 409, 'idempotency_key_reuse');
  err(await call('POST', `/requests/${id}/pay`, { token: w.cy, key: k() }), 409, 'request_not_pending');
  err(await call('POST', `/requests/${id}/decline`, { token: w.cy }), 409, 'request_not_pending');
  const list = await call('GET', '/requests?direction=incoming&status=paid', { token: w.cy });
  assert.equal(list.body.requests[0].payment_id, p.body.payment_id);
  // private payment: hidden from ada, visible to both parties
  const fa = await call('GET', '/activity', { token: w.ada });
  assert.ok(!fa.body.payments.some((x) => x.payment_id === p.body.payment_id));
  const fb = await call('GET', '/activity', { token: w.bob });
  assert.ok(fb.body.payments.some((x) => x.payment_id === p.body.payment_id));
  // ada cannot see bob/cy request
  const ra = await call('GET', '/requests', { token: w.ada });
  assert.ok(!ra.body.requests.some((x) => x.request_id === id));
});

test('concurrent pay with different keys moves money once', async () => {
  const w = await world();
  const r = await call('POST', '/requests', { token: w.bob, key: k(), body: { payer_handle: 'ada', amount: 100 } });
  const rs = await Promise.all(Array.from({ length: 30 }, () =>
    call('POST', `/requests/${r.body.request_id}/pay`, { token: w.ada, key: k() })));
  assert.equal(rs.filter((x) => x.status === 201).length, 1);
  assert.equal(await bal(w.ada), 9900);
});

test('decline/cancel', async () => {
  const w = await world();
  const mk = async () => (await call('POST', '/requests', { token: w.bob, key: k(), body: { payer_handle: 'ada', amount: 5 } })).body.request_id;
  const a = await mk();
  err(await call('POST', `/requests/${a}/decline`, { token: w.bob }), 403);
  assert.equal((await call('POST', `/requests/${a}/decline`, { token: w.ada })).body.status, 'declined');
  assert.equal((await call('POST', `/requests/${a}/decline`, { token: w.ada })).status, 200);
  err(await call('POST', `/requests/${a}/cancel`, { token: w.bob }), 409, 'request_not_pending');
  const b = await mk();
  err(await call('POST', `/requests/${b}/cancel`, { token: w.ada }), 403);
  assert.equal((await call('POST', `/requests/${b}/cancel`, { token: w.bob })).body.status, 'cancelled');
  assert.equal((await call('POST', `/requests/${b}/cancel`, { token: w.bob })).status, 200);
  err(await call('POST', `/requests/${b}/decline`, { token: w.ada }), 409);
});

test('list params', async () => {
  const w = await world();
  for (const q of ['limit=0', 'limit=201', 'limit=1e9', 'limit=4.0', 'limit=+4', 'offset=-1', 'limit=', 'direction=x', 'status=x']) {
    err(await call('GET', `/requests?${q}`, { token: w.ada }), 422, 'validation_failed');
    if (!q.startsWith('direction') && !q.startsWith('status')) err(await call('GET', `/activity?${q}`, { token: w.ada }), 422);
  }
  for (let i = 0; i < 5; i++) await call('POST', '/payments', { token: w.ada, key: k(), body: { to_handle: 'bob', amount: i + 1 } });
  const a = await call('GET', '/activity?limit=2&offset=1&foo=bar', { token: w.cy });
  assert.deepEqual(a.body.payments.map((p) => p.amount), [4, 3]); assert.equal(a.body.has_more, true);
  const b = await call('GET', '/activity?limit=2&offset=3', { token: w.cy });
  assert.equal(b.body.has_more, false);
});

test('splits', async () => {
  const w = await world();
  const cases = [[1000, [334, 333, 333]], [1, [1, 0, 0]], [10, [4, 3, 3]], [999, [333, 333, 333]]];
  for (const [amt, sh] of cases) {
    const r = await call('POST', '/splits', { token: w.ada, key: k(), body: { amount: amt, participant_handles: ['ada', 'bob', 'cy'], note: 'd' } });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.shares.map((s) => s.amount), sh);
    assert.equal(r.body.requests.length, 2);
    assert.deepEqual(r.body.requests.map((x) => x.payer_handle), ['bob', 'cy']);
  }
  const solo = await call('POST', '/splits', { token: w.ada, key: k(), body: { amount: 5, participant_handles: ['ada'] } });
  assert.equal(solo.status, 201); assert.deepEqual(solo.body.requests, []);
  const ex = await call('POST', '/splits', { token: w.ada, key: k(), body: { amount: 1, participant_handles: ['cy', 'bob'] } });
  assert.deepEqual(ex.body.shares, [{ handle: 'cy', amount: 1 }, { handle: 'bob', amount: 0 }]);
  assert.equal(ex.body.requests[1].amount, 0);
  err(await call('POST', '/splits', { token: w.ada, key: k(), body: { amount: 5, participant_handles: [] } }), 422);
  err(await call('POST', '/splits', { token: w.ada, key: k(), body: { amount: 5, participant_handles: ['bob', 'bob'] } }), 422);
  err(await call('POST', '/splits', { token: w.ada, key: k(), body: { amount: 5, participant_handles: ['bob', 'zed'] } }), 404);
  err(await call('POST', '/splits', { token: w.ada, key: k(), body: { amount: 5, participant_handles: 'bob' } }), 400);
  // zero-share request is payable?  amount 0 pays 0: fine either way, conservation holds
});

test('signup', async () => {
  await world();
  const s = await call('POST', '/auth/signup', { body: { email: 'Zed.X+1@Example.com', password: 'longenough', display_name: 'Zed' } });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const me = await call('GET', '/me', { token: s.body.token });
  assert.equal(me.body.handle, 'zed_x_1'); assert.equal(me.body.balance, 0);
  err(await call('POST', '/auth/signup', { body: { email: 'zed.x+1@example.com', password: 'longenough', display_name: 'Z' } }), 409, 'email_taken');
  err(await call('POST', '/auth/signup', { body: { email: 'ada@other.com', password: 'longenough', display_name: 'Z' } }), 409, 'handle_taken');
  err(await call('POST', '/auth/signup', { body: { email: 'noat', password: 'longenough', display_name: 'Z' } }), 422);
  err(await call('POST', '/auth/signup', { body: { email: 'q@x.com', password: 'short', display_name: 'Z' } }), 422);
  err(await call('POST', '/auth/signup', { body: { email: 1, password: 'longenough', display_name: 'Z' } }), 400);
  err(await call('POST', '/auth/login', { body: { email: 'ada@example.com', password: 'wrong pass' } }), 401);
  err(await call('POST', '/auth/login', { body: { email: 'nobody@example.com', password: 'wrong pass' } }), 401);
  assert.equal((await call('POST', '/auth/login', { body: { email: 'ADA@example.com', password: 'correct horse' } })).status, 200);
  // concurrent same-email signups: exactly one wins
  const rs = await Promise.all(Array.from({ length: 10 }, () =>
    call('POST', '/auth/signup', { body: { email: 'race@example.com', password: 'longenough', display_name: 'R' } })));
  assert.equal(rs.filter((r) => r.status === 201).length, 1);
});

test('reset validation and old tokens', async () => {
  const w = await world();
  err(await call('POST', '/_test/reset', { body: FX({ users: [U('ada', -1)] }) }), 422, 'validation_failed');
  assert.equal(await bal(w.ada), 10000); // unchanged
  await reset();
  err(await call('GET', '/me', { token: w.ada }), 401);
});

test('seeded payments and requests', async () => {
  await reset(FX({
    payments: [{ id: 'p_1', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 500, note: 'coffee', visibility: 'private' }],
    requests: [{ id: 'rq_1', requester_id: 'u_bob', payer_id: 'u_ada', amount: 1200, note: 'taxi', status: 'pending' }],
    settlement_operator_ids: ['u_cy'],
  }));
  const ada = await login('ada'), cy = await login('cy');
  const a = await call('GET', '/activity', { token: ada });
  assert.equal(a.body.payments[0].payment_id, 'p_1'); assert.equal(a.body.payments[0].from_handle, 'ada');
  assert.equal((await call('GET', '/activity', { token: cy })).body.payments.length, 0);
  const r = await call('GET', '/requests', { token: ada });
  assert.equal(r.body.requests[0].request_id, 'rq_1');
  const p = await call('POST', '/requests/rq_1/pay', { token: ada, key: k() });
  assert.equal(p.status, 201); assert.notEqual(p.body.payment_id, 'p_1');
  assert.ok(/[+-]\d\d:\d\d$/.test(p.body.created_at));
});

test('settlements', async () => {
  await reset(FX({ settlement_operator_ids: ['u_cy'] }));
  const ada = await login('ada'), bob = await login('bob'), cy = await login('cy');
  const T = (from, to, amount, extra = {}) => ({ from_handle: from, to_handle: to, amount, ...extra });
  err(await call('POST', '/settlements', { key: k(), body: { transfers: [T('ada', 'bob', 1)] } }), 401);
  err(await call('POST', '/settlements', { token: ada, key: k(), body: { transfers: [T('ada', 'bob', 1)] } }), 403, 'forbidden');
  err(await call('POST', '/settlements', { token: cy, body: { transfers: [T('ada', 'bob', 1)] } }), 400, 'missing_idempotency_key');
  for (const t of [undefined, [], 'x', [1], Array.from({ length: 33 }, () => T('ada', 'bob', 1))]) {
    err(await call('POST', '/settlements', { token: cy, key: k(), body: { transfers: t } }), 422, 'validation_failed');
  }
  err(await call('POST', '/settlements', { token: cy, key: k(), body: { transfers: [T('ada', 'zed', 1), T('ada', 'ada', 1)] } }), 404);
  err(await call('POST', '/settlements', { token: cy, key: k(), body: { transfers: [T('ada', 'ada', 1), T('ada', 'zed', 1)] } }), 422, 'self_payment');
  err(await call('POST', '/settlements', { token: cy, key: k(), body: { transfers: [T('cy', 'bob', 99999), T('ada', 'zed', 1)] } }), 404);
  // net-affordable chain: cy has 500, receives 1000 from ada, sends 1400
  const key = k();
  const body = { transfers: [T('cy', 'bob', 1400, { visibility: 'private', note: 'n' }), T('ada', 'cy', 1000)] };
  const s = await call('POST', '/settlements', { token: cy, key, body });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.equal(s.body.payments.length, 2);
  for (const p of s.body.payments) {
    assert.equal(p.settlement_id, s.body.settlement_id); assert.equal(p.created_at, s.body.committed_at); assert.equal(p.request_id, null);
  }
  assert.equal(await bal(cy), 100); assert.equal(await bal(bob), 3900); assert.equal(await bal(ada), 9000);
  const s2 = await call('POST', '/settlements', { token: cy, key, body });
  assert.equal(s2.status, 200); assert.deepEqual(s2.body, s.body);
  err(await call('POST', '/settlements', { token: cy, key: k(), body: { transfers: [T('cy', 'bob', 101)] } }), 409, 'insufficient_funds');
  assert.equal(await bal(cy), 100);
  // private member hidden from ada
  const fa = await call('GET', '/activity', { token: ada });
  assert.ok(!fa.body.payments.some((p) => p.payment_id === s.body.payments[0].payment_id));
  // ordinary payment has settlement_id null
  const pp = await call('POST', '/payments', { token: ada, key: k(), body: { to_handle: 'bob', amount: 1 } });
  assert.equal(pp.body.settlement_id, null);
});

test('export/import round trip', async () => {
  await reset(FX({ settlement_operator_ids: ['u_cy'] }));
  const ada = await login('ada'), cy = await login('cy');
  const key = k();
  const p = await call('POST', '/payments', { token: ada, key, body: { to_handle: 'bob', amount: 10 } });
  const fk = k();
  err(await call('POST', '/payments', { token: ada, key: fk, body: { to_handle: 'bob', amount: 999999 } }), 409);
  const ex = await call('GET', '/_test/export');
  assert.equal(ex.status, 200); assert.equal(ex.body.track, 'pocketful'); assert.equal(ex.body.format_version, 1);
  assert.ok(!JSON.stringify(ex.body).includes('correct horse'));
  await call('POST', '/payments', { token: ada, key: k(), body: { to_handle: 'bob', amount: 10 } });
  const ex2 = await call('GET', '/_test/export');
  assert.notDeepEqual(ex2.body, ex.body);
  // invalid imports leave state unchanged
  err(await call('POST', '/_test/import', { raw: '{nope' }), 400);
  err(await call('POST', '/_test/import', { body: { ...ex.body, track: 'x' } }), 422);
  err(await call('POST', '/_test/import', { body: { ...ex.body, format_version: 2 } }), 422);
  err(await call('POST', '/_test/import', { body: { track: 'pocketful', format_version: 1 } }), 422);
  err(await call('POST', '/_test/import', { body: { ...ex.body, state: { ...ex.body.state, users: 5 } } }), 422);
  assert.equal(await bal(ada), 9980);
  await reset(FX({ users: [U('zz', 5)] }));
  assert.equal((await call('POST', '/_test/import', { body: ex.body })).status, 204);
  assert.equal((await call('POST', '/_test/import', { body: ex.body })).status, 204);
  assert.equal(await bal(ada), 9990); // old token still valid
  const r = await call('POST', '/payments', { token: ada, key, body: { to_handle: 'bob', amount: 10 } });
  assert.equal(r.status, 200); assert.deepEqual(r.body, p.body);
  assert.equal((await call('POST', '/payments', { token: ada, key: fk, body: { to_handle: 'bob', amount: 1 } })).status, 201);
  assert.equal((await call('POST', '/auth/login', { body: { email: 'ada@example.com', password: 'correct horse' } })).status, 200);
  assert.equal((await call('POST', '/auth/login', { body: { email: 'zz@example.com', password: 'correct horse' } })).status, 401);
  const a = await call('GET', '/activity', { token: cy });
  assert.equal(a.body.payments.length, 2);
  // new ids do not collide
  const n = await call('POST', '/payments', { token: ada, key: k(), body: { to_handle: 'bob', amount: 1 } });
  assert.ok(!a.body.payments.some((x) => x.payment_id === n.body.payment_id));
  assert.equal((await call('POST', '/settlements', { token: cy, key: k(), body: { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 1 }] } })).status, 201);
});

test('routing, 405, 413, reset perf', async () => {
  err(await call('GET', '/nope'), 404, 'not_found');
  err(await call('DELETE', '/payments'), 405);
  err(await call('POST', '/payments', { raw: 'x'.repeat(2 << 20) }), 413);
  const users = Array.from({ length: 200 }, (_, i) => U(`u${i}`, 100));
  const t0 = Date.now();
  await reset(FX({ users }));
  const dt = Date.now() - t0;
  assert.ok(dt < 5000, `reset took ${dt}ms`);
  const t1 = Date.now();
  const rs = await Promise.all(users.slice(0, 50).map((u) => call('POST', '/auth/login', { body: { email: u.email, password: 'correct horse' } })));
  assert.ok(rs.every((r) => r.status === 200));
  console.log(`    reset(200 users)=${dt}ms, 50 concurrent logins=${Date.now() - t1}ms`);
});

test('D11: malformed or unknown handle strings are 404 at every site, D2 order kept', async () => {
  await reset(FX({ settlement_operator_ids: ['u_cy'] }));
  const ada = await login('ada'), cy = await login('cy');
  for (const h of ['BOB', 'no-such', '', 'x'.repeat(30), 'zed']) {
    err(await call('POST', '/payments', { token: ada, key: k(), body: { to_handle: h, amount: 1 } }), 404, 'not_found');
    err(await call('POST', '/requests', { token: ada, key: k(), body: { payer_handle: h, amount: 1 } }), 404, 'not_found');
    err(await call('POST', '/splits', { token: ada, key: k(), body: { amount: 3, participant_handles: ['bob', h] } }), 404, 'not_found');
    err(await call('POST', '/settlements', { token: cy, key: k(), body: { transfers: [{ from_handle: h, to_handle: 'bob', amount: 1 }] } }), 404, 'not_found');
    err(await call('POST', '/settlements', { token: cy, key: k(), body: { transfers: [{ from_handle: 'ada', to_handle: h, amount: 1 }] } }), 404, 'not_found');
  }
  // field validation still precedes the lookup
  err(await call('POST', '/payments', { token: ada, key: k(), body: { to_handle: 'BOB', amount: 0 } }), 422, 'validation_failed');
  err(await call('POST', '/payments', { token: ada, key: k(), body: { to_handle: 'BOB', amount: 1, visibility: 'x' } }), 422, 'validation_failed');
  err(await call('POST', '/requests', { token: ada, key: k(), body: { payer_handle: 'BOB', amount: 1, note: null } }), 422, 'validation_failed');
  err(await call('POST', '/splits', { token: ada, key: k(), body: { amount: 3, participant_handles: ['BOB', 'BOB'] } }), 422, 'validation_failed');
  err(await call('POST', '/splits', { token: ada, key: k(), body: { amount: 3, participant_handles: [] } }), 422, 'validation_failed');
  err(await call('POST', '/settlements', { token: cy, key: k(), body: { transfers: [{ from_handle: 'BOB', to_handle: 'bob', amount: 0 }] } }), 422, 'validation_failed');
  // wrong JSON type stays 400 (fields) / 422 (settlement entry)
  err(await call('POST', '/payments', { token: ada, key: k(), body: { to_handle: null, amount: 1 } }), 400, 'malformed_request');
  err(await call('POST', '/splits', { token: ada, key: k(), body: { amount: 3, participant_handles: ['bob', 7] } }), 400, 'malformed_request');
  err(await call('POST', '/settlements', { token: cy, key: k(), body: { transfers: [{ from_handle: 5, to_handle: 'bob', amount: 1 }] } }), 422, 'validation_failed');
});

test('F3: settlement entry errors in input order, non-object entries included', async () => {
  await reset(FX({ settlement_operator_ids: ['u_cy'] }));
  const cy = await login('cy');
  err(await call('POST', '/settlements', { token: cy, key: k(), body: { transfers: [{ from_handle: 'zz', to_handle: 'bob', amount: 1 }, 5] } }), 404, 'not_found');
  err(await call('POST', '/settlements', { token: cy, key: k(), body: { transfers: [5, { from_handle: 'zz', to_handle: 'bob', amount: 1 }] } }), 422, 'validation_failed');
  err(await call('POST', '/settlements', { token: cy, key: k(), body: { transfers: [{ from_handle: 'ada', to_handle: 'ada', amount: 1 }, null] } }), 422, 'self_payment');
});

test('F2: 1000-user reset with a shared password stays fast; seeded logins work', async () => {
  const users = Array.from({ length: 1000 }, (_, i) => U(`v${i}`, 5));
  users[3] = U('v3', 5, { password: 'another secret' });
  const t0 = Date.now();
  await reset({ currency: 'JPY', minor_units: 0, users });
  const dt = Date.now() - t0;
  assert.ok(dt < 3000, `reset took ${dt}ms`);
  assert.equal((await call('POST', '/auth/login', { body: { email: 'v999@example.com', password: 'correct horse' } })).status, 200);
  assert.equal((await call('POST', '/auth/login', { body: { email: 'v3@example.com', password: 'another secret' } })).status, 200);
  assert.equal((await call('POST', '/auth/login', { body: { email: 'v3@example.com', password: 'correct horse' } })).status, 401);
  const ex = await call('GET', '/_test/export');
  assert.ok(!JSON.stringify(ex.body).includes('correct horse'));
  console.log(`    reset(1000 users)=${dt}ms`);
});

test('F4: signup display_name optional, defaults to derived handle; non-string 400; empty kept', async () => {
  await world();
  const a = await call('POST', '/auth/signup', { body: { email: 'No.Name@example.com', password: 'longenough' } });
  assert.equal(a.status, 201, JSON.stringify(a.body)); assert.equal(a.body.display_name, 'no_name');
  assert.equal((await call('GET', '/me', { token: a.body.token })).body.display_name, 'no_name');
  const b = await call('POST', '/auth/signup', { body: { email: 'empty@example.com', password: 'longenough', display_name: '' } });
  assert.equal(b.status, 201); assert.equal(b.body.display_name, '');
  const v = await call('POST', '/auth/signup', { body: { email: 'verb@example.com', password: 'longenough', display_name: '  Zoë 😀 ' } });
  assert.equal(v.body.display_name, '  Zoë 😀 ');
  err(await call('POST', '/auth/signup', { body: { email: 'n1@example.com', password: 'longenough', display_name: null } }), 400, 'malformed_request');
  err(await call('POST', '/auth/signup', { body: { email: 'n2@example.com', password: 'longenough', display_name: 5 } }), 400, 'malformed_request');
});

test('F2: 2000-user reset with all-distinct passwords stays well under 10 s', async () => {
  const users = Array.from({ length: 2000 }, (_, i) => U(`w${i}`, 1, { password: `secret-${i}` }));
  const t0 = Date.now();
  await reset({ currency: 'BHD', minor_units: 3, users });
  const dt = Date.now() - t0;
  assert.ok(dt < 8000, `reset took ${dt}ms`);
  assert.equal((await call('POST', '/auth/login', { body: { email: 'w1999@example.com', password: 'secret-1999' } })).status, 200);
  assert.equal((await call('POST', '/auth/login', { body: { email: 'w1999@example.com', password: 'secret-1998' } })).status, 401);
  console.log(`    reset(2000 distinct passwords)=${dt}ms`);
});

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'inherit'] });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/health')).ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const [name, fn] of tests) {
    try { await fn(); passes++; console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + '\n     ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n     ')); }
  }
  child.kill();
  console.log(`${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
