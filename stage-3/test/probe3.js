'use strict';
// Stage-3 (W3a) self-tests: payment timestamps, opening balances, /me as_of/known_at, statements,
// snapshots, historical holds and stage-1/2 -> stage-3 imports.
// Run: node stage-3/test/probe3.js   (spawns stage-3, stage-2 and stage-1 server.js locally)
//  or: BASE=... S1BASE=... S2BASE=... node stage-3/test/probe3.js   (containers)
const { spawn } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');

const rnd = () => 17000 + Math.floor(Math.random() * 900);
const BASE = process.env.BASE || `http://127.0.0.1:${rnd()}`;
const S1BASE = process.env.S1BASE || `http://127.0.0.1:${rnd() + 1000}`;
const S2BASE = process.env.S2BASE || `http://127.0.0.1:${rnd() + 2000}`;
let failures = 0, passes = 0;

async function call(method, p, { body, token, key, base = BASE, rawQuery } = {}) {
  const h = {};
  if (token) h.authorization = `Bearer ${token}`;
  if (key !== undefined) h['idempotency-key'] = key;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, body: json };
}
const k = () => 'k' + Math.random().toString(36).slice(2) + Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const U = (h, bal, extra = {}) => ({ id: `u_${h}`, email: `${h}@example.com`, password: 'correct horse', display_name: h, handle: h, balance: bal, ...extra });
const FX = (extra = {}) => ({ currency: 'EUR', minor_units: 2, users: [U('ada', 10000), U('bob', 2500), U('cy', 500)], ...extra });
const isoMs = (ms) => new Date(ms).toISOString().replace('Z', '+00:00');
const ms = (iso) => Date.parse(iso);
// The instant 1 microsecond before a millisecond-precision instant.
const minus1us = (iso) => { const d = isoMs(ms(iso) - 1); return d.replace(/\.(\d{3})\+/, '.$1999+'); };
const enc = encodeURIComponent;

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
const pay = async (t, to, amount, base = BASE, extra = {}) => {
  const r = await call('POST', '/payments', { token: t, key: k(), body: { to_handle: to, amount, ...extra }, base });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
const me = (t, qs = '') => call('GET', '/me' + qs, { token: t });
const stmt = (t, qs = '') => call('GET', '/statement' + qs, { token: t });
const err = (r, status, code) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  if (code) assert.equal(r.body.error.code, code, JSON.stringify(r.body));
};
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('payment created_at: strictly increasing server clock, RFC 3339 with offset', async () => {
  const w = await world();
  const ps = await Promise.all(Array.from({ length: 30 }, () => pay(w.ada, 'bob', 1)));
  const times = ps.map((p) => p.created_at);
  assert.equal(new Set(times).size, 30, 'server instants are unique');
  for (const t of times) assert.match(t, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+00:00$/);
  const feed = (await call('GET', '/activity?limit=200', { token: w.ada })).body.payments.map((p) => p.created_at);
  assert.deepEqual(feed, [...feed].sort().reverse());
});

test('seeded created_at: verbatim, ordering, opening balances, future/invalid -> 422', async () => {
  const fx = FX({ payments: [
    { id: 'p_late', from_user_id: 'u_bob', to_user_id: 'u_ada', amount: 200, created_at: '2026-01-02T10:00:00+02:00' },
    { id: 'p_early', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 500, note: 'coffee', created_at: '2026-01-01T09:00:00Z' },
    { id: 'p_now', from_user_id: 'u_cy', to_user_id: 'u_ada', amount: 100 },
  ] });
  const w = await world(fx);
  const feed = (await call('GET', '/activity', { token: w.ada })).body.payments;
  assert.deepEqual(feed.map((p) => p.payment_id), ['p_now', 'p_late', 'p_early']);
  assert.equal(feed.find((p) => p.payment_id === 'p_late').created_at, '2026-01-02T10:00:00+02:00');
  // balances are as seeded (not replayed)
  assert.equal((await me(w.ada)).body.balance, 10000);
  // opening = seeded balance - net of seeded payments
  const before = (await me(w.ada, `?as_of=${enc('2025-12-31T00:00:00Z')}`)).body;
  assert.equal(before.balance, 10000 + 500 - 200 - 100);
  assert.equal((await me(w.bob, '?as_of=2025-12-31T00:00:00Z')).body.balance, 2500 - 500 + 200);
  const new1 = await pay(w.ada, 'bob', 1);
  const s = (await stmt(w.ada)).body;
  assert.deepEqual(s.entries.map((e) => e.payment.payment_id), ['p_early', 'p_late', 'p_now', new1.payment_id]);
  assert.equal(s.opening_balance, 10200);
  // seeded revision 1 uses the supplied created_at
  assert.equal(s.entries[0].effective_at, '2026-01-01T09:00:00Z');
  assert.equal(s.entries[0].recorded_at, '2026-01-01T09:00:00Z');
  const future = isoMs(Date.now() + 3600e3);
  for (const bad of [future, '2026-01-01T09:00:00', '2026-01-01', '', '2026-02-30T00:00:00Z', 5]) {
    err(await call('POST', '/_test/reset', { body: FX({ payments: [{ id: 'p', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 1, created_at: bad }] }) }), 422, 'validation_failed');
  }
  assert.equal((await me(w.ada)).body.balance, 9999); // unchanged by the refused resets
});

test('/me as_of: inclusive at created_at, sub-ms, before earliest, future, echo, 422s', async () => {
  const w = await world();
  const p1 = await pay(w.ada, 'bob', 1000);
  await sleep(5);
  const p2 = await pay(w.ada, 'cy', 300);
  const at = async (iso) => (await me(w.ada, `?as_of=${enc(iso)}`)).body;
  assert.equal((await at(p1.created_at)).balance, 9000, 'a payment at exactly as_of counts');
  assert.equal((await at(minus1us(p1.created_at))).balance, 10000, '1 microsecond earlier excludes it');
  assert.equal((await at(minus1us(p2.created_at))).balance, 9000);
  assert.equal((await at(p2.created_at)).balance, 8700);
  assert.equal((await at('2000-01-01T00:00:00Z')).balance, 10000, 'before the earliest -> opening');
  const fut = await at('2999-01-01T00:00:00+05:00');
  assert.equal(fut.balance, 8700);
  assert.equal(fut.as_of, '2999-01-01T00:00:00+05:00');
  // the same instant written with another offset
  const d = new Date(ms(p1.created_at) + 2 * 3600e3).toISOString().replace('Z', '+02:00');
  assert.equal((await at(d)).balance, 9000);
  // raw '+' in the query is a '+' (not a space); %2B too
  const raw = await call('GET', `/me?as_of=${p1.created_at}`, { token: w.ada });
  assert.equal(raw.status, 200); assert.equal(raw.body.as_of, p1.created_at); assert.equal(raw.body.balance, 9000);
  const pct = await call('GET', `/me?as_of=${p1.created_at.replace('+', '%2B')}`, { token: w.ada });
  assert.equal(pct.body.as_of, p1.created_at);
  // fields: all four money fields describe the same view
  const v = await at(p1.created_at);
  assert.equal(v.total, v.balance); assert.equal(v.available, v.total - v.held);
  for (const bad of ['', '2026-09-24T13:20:00', '2026-09-24', 'yesterday', '2026-09-24T13:20:00 00:00', '2026-13-01T00:00:00Z', '2026-09-24T24:00:00Z', '2026-09-24T13:20:00+24:00', '2026-09-24 13:20:00Z']) {
    err(await call('GET', `/me?as_of=${enc(bad)}`, { token: w.ada }), 422, 'validation_failed');
    err(await call('GET', `/me?known_at=${enc(bad)}`, { token: w.ada }), 422, 'validation_failed');
  }
  err(await call('GET', '/me?as_of', { token: w.ada }), 422);
  // no temporal params: stage-2 shape exactly
  const plain = (await me(w.ada)).body;
  assert.ok(!('as_of' in plain) && !('known_at' in plain));
  assert.equal(plain.balance, 8700);
  err(await call('GET', '/me?as_of=2026-01-01T00:00:00Z'), 401);
});

test('known_at: before a payment was recorded it contributes nothing; future ok; echoed', async () => {
  const w = await world();
  const p1 = await pay(w.ada, 'bob', 1000);
  const v = (await me(w.ada, `?known_at=${enc(minus1us(p1.created_at))}`)).body;
  assert.equal(v.balance, 10000); assert.equal(v.known_at, minus1us(p1.created_at));
  assert.equal((await me(w.ada, `?known_at=${enc(p1.created_at)}`)).body.balance, 9000);
  assert.equal((await me(w.ada, '?known_at=2999-01-01T00:00:00Z&as_of=2999-01-01T00:00:00Z')).body.balance, 9000);
  const s = (await stmt(w.ada, `?known_at=${enc(minus1us(p1.created_at))}`)).body;
  assert.equal(s.entries.length, 0); assert.equal(s.closing_balance, 10000); assert.equal(s.known_at, minus1us(p1.created_at));
});

test('statement: window, ordering, ties by id, deltas, opening+Σ=closing, only own payments', async () => {
  const w = await world(FX({ settlement_operator_ids: ['u_cy'] }));
  const p1 = await pay(w.ada, 'bob', 500, BASE, { note: 'a', visibility: 'private' });
  const p2 = await pay(w.bob, 'ada', 1200);
  await pay(w.bob, 'cy', 7); // public but not ada's
  const st = await call('POST', '/settlements', { token: w.cy, key: k(), body: { transfers: Array.from({ length: 12 }, (_, i) => (
    i % 2 ? { from_handle: 'ada', to_handle: 'bob', amount: 10 + i } : { from_handle: 'bob', to_handle: 'ada', amount: 1 + i })) } });
  assert.equal(st.status, 201);
  const s = (await stmt(w.ada)).body;
  assert.ok(typeof s.snapshot === 'string' && s.snapshot.length > 8);
  const ids = s.entries.map((e) => e.payment.payment_id);
  assert.ok(!ids.includes(undefined));
  assert.equal(s.entries.length, 2 + 12);
  assert.deepEqual(ids.slice(0, 2), [p1.payment_id, p2.payment_id]);
  const members = s.entries.slice(2).map((e) => e.payment.payment_id);
  assert.deepEqual(members, [...members].sort(), 'members share created_at, so id order (code units)');
  assert.ok(s.entries.slice(2).every((e) => e.effective_at === st.body.committed_at && e.recorded_at === st.body.committed_at && e.revision === 1));
  assert.equal(s.entries[0].delta, -500); assert.equal(s.entries[1].delta, 1200);
  let run = s.opening_balance;
  for (const e of s.entries) { run += e.delta; assert.equal(e.balance_after, run); assert.equal(Math.abs(e.delta), e.payment.amount); }
  assert.equal(s.closing_balance, run);
  assert.equal(s.opening_balance, 10000);
  assert.equal(s.closing_balance, (await me(w.ada)).body.balance);
  assert.equal(s.has_more, false);
  assert.equal(s.entries[0].payment.visibility, 'private');
  // half-open windows
  const w1 = (await stmt(w.ada, `?from=${enc(p1.created_at)}&to=${enc(p2.created_at)}`)).body;
  assert.deepEqual(w1.entries.map((e) => e.payment.payment_id), [p1.payment_id]);
  assert.equal(w1.opening_balance, 10000); assert.equal(w1.closing_balance, 9500);
  assert.equal(w1.from, p1.created_at); assert.equal(w1.to, p2.created_at);
  const w2 = (await stmt(w.ada, `?from=${enc(p2.created_at)}`)).body;
  assert.equal(w2.opening_balance, 9500); assert.equal(w2.entries[0].payment.payment_id, p2.payment_id);
  const same = (await stmt(w.ada, `?from=${enc(p2.created_at)}&to=${enc(p2.created_at)}`)).body;
  assert.equal(same.entries.length, 0); assert.equal(same.opening_balance, same.closing_balance);
  err(await stmt(w.ada, `?from=${enc(p2.created_at)}&to=${enc(p1.created_at)}`), 422);
  for (const q of ['from=', 'to=2026-01-01', 'known_at=x', 'limit=0', 'offset=-1', 'limit=4.0', 'from=2026-01-01T00:00:00']) err(await stmt(w.ada, '?' + q), 422, 'validation_failed');
  err(await call('GET', '/statement'), 401);
  // cy sees only own entries even though bob->ada payments are public
  const sc = (await stmt(w.cy)).body;
  assert.equal(sc.entries.length, 1);
});

test('statement pagination invariance and snapshots', async () => {
  const w = await world();
  for (let i = 0; i < 7; i++) await pay(i % 2 ? w.bob : w.ada, i % 2 ? 'ada' : 'bob', 100 + i);
  const full = (await stmt(w.ada)).body;
  const pages = [];
  let snap = null;
  for (let off = 0; off < 9; off += 3) {
    const r = (await stmt(w.ada, `?limit=3&offset=${off}`)).body;
    assert.equal(r.opening_balance, full.opening_balance); assert.equal(r.closing_balance, full.closing_balance);
    pages.push(...r.entries);
    assert.equal(r.has_more, off + 3 < 7);
  }
  assert.deepEqual(pages, full.entries);
  // snapshot paging after new writes
  const first = (await stmt(w.ada, '?limit=2')).body;
  snap = first.snapshot;
  await pay(w.ada, 'bob', 999);
  await pay(w.bob, 'ada', 1);
  const all = [];
  for (let off = 0; off < 10; off += 2) {
    const r = await stmt(w.ada, `?snapshot=${snap}&limit=2&offset=${off}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.snapshot, snap);
    assert.equal(r.body.closing_balance, full.closing_balance);
    assert.equal(r.body.has_more, off + 2 < 7, `has_more at offset ${off}`);
    all.push(...r.body.entries);
  }
  assert.deepEqual(all, full.entries);
  const beyond = (await stmt(w.ada, `?snapshot=${snap}&offset=50`)).body;
  assert.deepEqual(beyond.entries, []); assert.equal(beyond.has_more, false);
  const partial = (await stmt(w.ada, `?snapshot=${snap}&limit=5&offset=5`)).body;
  assert.equal(partial.entries.length, 2); assert.equal(partial.has_more, false);
  for (const q of ['from=', 'to=2026-01-01T00:00:00Z', 'known_at=2026-01-01T00:00:00Z', 'from=2026-01-01T00:00:00Z']) {
    err(await stmt(w.ada, `?snapshot=${snap}&${q}`), 422, 'validation_failed');
  }
  err(await stmt(w.ada, `?snapshot=${snap}&limit=0`), 422);
  err(await stmt(w.ada, '?snapshot=nope'), 404, 'not_found');
  err(await stmt(w.ada, '?snapshot='), 404, 'not_found');
  err(await stmt(w.bob, `?snapshot=${snap}`), 404, 'not_found');
  assert.equal((await stmt(w.ada, `?snapshot=${snap}&foo=bar`)).status, 200);
  // snapshot survives export/import, not reset
  const ex = (await call('GET', '/_test/export')).body;
  await reset();
  const ada2 = await login('ada');
  err(await stmt(ada2, `?snapshot=${snap}`), 404, 'not_found');
  assert.equal((await call('POST', '/_test/import', { body: ex })).status, 204);
  const back = await stmt(w.ada, `?snapshot=${snap}&limit=200`);
  assert.equal(back.status, 200); assert.deepEqual(back.body.entries, full.entries);
});

test('historical holds: create, nonfinal capture, final capture, void, expiry, closed_at', async () => {
  const w = await world(FX({ authorization_ttl_seconds: 2 }));
  const a = (await call('POST', '/authorizations', { token: w.ada, key: k(), body: { to_handle: 'bob', amount: 3000 } })).body;
  assert.equal(a.closed_at, null);
  await sleep(5);
  const c1 = (await call('POST', `/authorizations/${a.authorization_id}/capture`, { token: w.bob, key: k(), body: { amount: 1000, final: false } })).body;
  await sleep(5);
  const c2 = (await call('POST', `/authorizations/${a.authorization_id}/capture`, { token: w.bob, key: k(), body: { amount: 500 } })).body;
  const v = (await call('POST', '/authorizations', { token: w.ada, key: k(), body: { to_handle: 'cy', amount: 700 } })).body;
  await sleep(5);
  const vd = (await call('POST', `/authorizations/${v.authorization_id}/void`, { token: w.ada })).body;
  const e = (await call('POST', '/authorizations', { token: w.ada, key: k(), body: { to_handle: 'cy', amount: 400 } })).body;
  const view = async (asOf, knownAt) => (await me(w.ada, `?as_of=${enc(asOf)}${knownAt ? `&known_at=${enc(knownAt)}` : ''}`)).body;
  let x = await view(minus1us(a.created_at));
  assert.deepEqual([x.total, x.held, x.available], [10000, 0, 10000]);
  x = await view(a.created_at);
  assert.deepEqual([x.total, x.held, x.available], [10000, 3000, 7000]);
  x = await view(c1.created_at);
  assert.deepEqual([x.total, x.held, x.available], [9000, 2000, 7000]);
  x = await view(c1.created_at, minus1us(c1.created_at)); // capture not yet known
  assert.deepEqual([x.total, x.held, x.available], [10000, 3000, 7000]);
  x = await view(c2.created_at);
  assert.deepEqual([x.total, x.held, x.available], [8500, 0, 8500]);
  x = await view(v.created_at);
  assert.deepEqual([x.total, x.held], [8500, 700]);
  x = await view(vd.closed_at);
  assert.deepEqual([x.total, x.held], [8500, 0]);
  assert.equal(vd.closed_at > v.created_at, true);
  x = await view(e.created_at);
  assert.equal(x.held, 400);
  x = await view(e.expires_at);
  assert.equal(x.held, 0, 'expiry releases at expires_at');
  x = await view(minus1us(e.expires_at));
  assert.equal(x.held, 400);
  x = await view('2999-01-01T00:00:00Z'); // beyond now: open holds expire at their deadline
  assert.equal(x.held, 0);
  const list = (await call('GET', '/authorizations', { token: w.ada })).body.authorizations;
  const by = Object.fromEntries(list.map((z) => [z.authorization_id, z]));
  assert.equal(by[a.authorization_id].closed_at, c2.created_at);
  assert.equal(by[v.authorization_id].closed_at, vd.closed_at);
  assert.equal(by[e.authorization_id].closed_at, null);
  await sleep(2100);
  const after = (await call('GET', '/authorizations', { token: w.ada })).body.authorizations.find((z) => z.authorization_id === e.authorization_id);
  assert.equal(after.status, 'expired'); assert.equal(after.closed_at, e.expires_at);
  // statement: money movements only, captures exactly once
  const s = (await stmt(w.ada)).body;
  assert.deepEqual(s.entries.map((z) => [z.payment.authorization_id, z.delta]), [[a.authorization_id, -1000], [a.authorization_id, -500]]);
  // current /me unchanged in shape
  const cur = (await me(w.ada)).body;
  assert.deepEqual([cur.total, cur.held], [8500, 0]);
});

test('seeded holds: open at reset or supplied created_at; closed hold nothing; closed_at', async () => {
  const hour = 3600e3, now = Date.now();
  const fx = FX({ authorizations: [
    { id: 'a_open', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 2000, status: 'open', expires_at: isoMs(now + 2 * hour) },
    { id: 'a_old', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 1000, status: 'open', captured_amount: 400, created_at: isoMs(now - 3 * hour), expires_at: isoMs(now + 2 * hour) },
    { id: 'a_cap', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 5000, status: 'captured', expires_at: isoMs(now + 2 * hour) },
    { id: 'a_exp', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 5000, status: 'open', expires_at: isoMs(now - 2 * hour) },
  ] });
  const w = await world(fx);
  const cur = (await me(w.ada)).body;
  assert.equal(cur.held, 2600);
  const at = async (t) => (await me(w.ada, `?as_of=${enc(t)}`)).body.held;
  assert.equal(await at(isoMs(now - 2.5 * hour)), 600, 'a_old existed (with 400 already captured); a_exp expired? no: before its deadline');
  assert.equal(await at(isoMs(now - 4 * hour)), 0);
  const list = Object.fromEntries((await call('GET', '/authorizations', { token: w.ada })).body.authorizations.map((z) => [z.authorization_id, z]));
  assert.equal(list.a_open.closed_at, null);
  assert.equal(list.a_exp.closed_at, list.a_exp.expires_at);
  assert.ok(list.a_cap.closed_at);
});

test('stage-3 export/import round trip, tampering -> 422', async () => {
  const w = await world();
  const p = await pay(w.ada, 'bob', 250);
  const s1 = (await stmt(w.ada)).body;
  const ex = (await call('GET', '/_test/export')).body;
  await reset(FX({ users: [U('zz', 1)] }));
  assert.equal((await call('POST', '/_test/import', { body: ex })).status, 204);
  const s2 = (await stmt(w.ada, `?snapshot=${s1.snapshot}`)).body;
  assert.deepEqual(s2.entries, s1.entries);
  assert.equal((await me(w.ada, '?as_of=2000-01-01T00:00:00Z')).body.balance, 10000);
  const after = await pay(w.ada, 'bob', 1);
  assert.ok(ms(after.created_at) > ms(p.created_at));
  const tamper = [
    (st) => { st.revisions[0][1][0].amount += 1; },
    (st) => { st.users[0].opening += 1; },
    (st) => { st.revisions = []; },
    (st) => { st.ledger_version = 9; },
    (st) => { st.revisions[0][1][0].effective_at = '2026-01-01'; },
    (st) => { st.snapshots = [['x', { owner: 'nobody' }]]; },
  ];
  for (const t of tamper) {
    const bad = JSON.parse(JSON.stringify(ex)); t(bad.state);
    err(await call('POST', '/_test/import', { body: bad }), 422, 'validation_failed');
  }
  assert.equal((await me(w.ada)).body.balance, 9749);
});

test('stage-1 and stage-2 exports import into stage-3 with a derived ledger', async () => {
  // stage 1
  await reset(FX({ settlement_operator_ids: ['u_cy'], payments: [{ id: 'p_seed', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 500 }] }), S1BASE);
  const a1 = await login('ada', S1BASE), c1 = await login('cy', S1BASE);
  const key = k();
  const lost = (await call('POST', '/payments', { token: a1, key, body: { to_handle: 'bob', amount: 300 }, base: S1BASE })).body;
  await call('POST', '/settlements', { token: c1, key: k(), body: { transfers: [{ from_handle: 'bob', to_handle: 'ada', amount: 50 }] }, base: S1BASE });
  const ex1 = (await call('GET', '/_test/export', { base: S1BASE })).body;
  await reset();
  assert.equal((await call('POST', '/_test/import', { body: ex1 })).status, 204);
  const m1 = (await me(a1)).body;
  assert.equal(m1.balance, 10000 - 300 + 50);
  assert.equal((await me(a1, '?as_of=2000-01-01T00:00:00Z')).body.balance, 10000 + 500);
  const s = (await stmt(a1)).body;
  assert.equal(s.opening_balance, 10500); assert.equal(s.closing_balance, m1.balance);
  assert.equal(s.entries.length, 3);
  assert.ok(s.entries.every((e) => e.revision === 1 && e.effective_at === e.payment.created_at));
  const replay = await call('POST', '/payments', { token: a1, key, body: { to_handle: 'bob', amount: 300 } });
  assert.equal(replay.status, 200); assert.deepEqual(replay.body, lost);
  const fresh = await pay(a1, 'bob', 1);
  assert.ok(ms(fresh.created_at) > ms(lost.created_at));
  // stage 2 with holds and captures
  await reset(FX({ authorization_ttl_seconds: 900 }), S2BASE);
  const a2 = await login('ada', S2BASE), b2 = await login('bob', S2BASE);
  const h1 = (await call('POST', '/authorizations', { token: a2, key: k(), body: { to_handle: 'bob', amount: 2000 }, base: S2BASE })).body;
  await sleep(5);
  const cap = (await call('POST', `/authorizations/${h1.authorization_id}/capture`, { token: b2, key: k(), body: { amount: 600, final: false }, base: S2BASE })).body;
  const h2 = (await call('POST', '/authorizations', { token: a2, key: k(), body: { to_handle: 'cy', amount: 100 }, base: S2BASE })).body;
  await call('POST', `/authorizations/${h2.authorization_id}/void`, { token: a2, base: S2BASE });
  const ex2 = (await call('GET', '/_test/export', { base: S2BASE })).body;
  await reset();
  assert.equal((await call('POST', '/_test/import', { body: ex2 })).status, 204);
  const m2 = (await me(a2)).body;
  assert.deepEqual([m2.total, m2.held, m2.available], [9400, 1400, 8000]);
  const hist = async (t) => (await me(a2, `?as_of=${enc(t)}`)).body;
  let x = await hist(h1.created_at);
  assert.deepEqual([x.total, x.held], [10000, 2000]);
  x = await hist(cap.created_at);
  assert.deepEqual([x.total, x.held], [9400, 1400]);
  const views = Object.fromEntries((await call('GET', '/authorizations', { token: a2 })).body.authorizations.map((z) => [z.authorization_id, z]));
  assert.equal(views[h1.authorization_id].closed_at, null);
  assert.ok(views[h2.authorization_id].closed_at);
  const s2 = (await stmt(a2)).body;
  assert.equal(s2.entries.length, 1); assert.equal(s2.entries[0].payment.authorization_id, h1.authorization_id);
  const h3 = await call('POST', '/authorizations', { token: a2, key: k(), body: { to_handle: 'bob', amount: 1 } });
  assert.equal(ms(h3.body.expires_at) - ms(h3.body.created_at), 900000);
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
  if (!process.env.S1BASE) await up(S1BASE, path.join(__dirname, '..', '..', 'stage-1', 'server.js'));
  if (!process.env.S2BASE) await up(S2BASE, path.join(__dirname, '..', '..', 'stage-2', 'server.js'));
  for (const [name, fn] of tests) {
    try { await fn(); passes++; console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + '\n     ' + (e.stack || e).toString().split('\n').slice(0, 6).join('\n     ')); }
  }
  for (const c of kids) c.kill();
  console.log(`${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
