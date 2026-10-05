'use strict';
// Reviewer probes for W2a (rev ba85eef): authorizations, holds, captures, voids, expiry,
// available-based funds checks, fixture/import edge cases, concurrency.
// Usage: BASE=http://127.0.0.1:19090 [S1BASE=http://127.0.0.1:19091] node stage-2/review/rev-w2a-probe.js
const BASE = process.env.BASE || 'http://127.0.0.1:19090';
const S1BASE = process.env.S1BASE;
let pass = 0, fail = 0; const out = [];
const check = (n, c, d) => { if (c) pass++; else { fail++; out.push(`FAIL ${n} :: ${d}`); } };
async function call(method, p, { body, raw, token, key, base = BASE } = {}) {
  const h = {};
  if (token) h.authorization = `Bearer ${token}`;
  if (key !== undefined) h['idempotency-key'] = key;
  const payload = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined;
  const r = await fetch(base + p, { method, headers: h, body: payload });
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  return { status: r.status, body: j };
}
const code = (r) => r.body && r.body.error && r.body.error.code;
const sc = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0; const k = () => `w2a_${Date.now()}_${n++}`;
const U = (h, bal) => ({ id: `u_${h}`, email: `${h}@example.com`, password: 'correct horse', display_name: h, handle: h, balance: bal });
const iso = (ms) => new Date(ms).toISOString().replace('Z', '+00:00');
const H = 3600e3;
async function reset(fx, base = BASE) { const r = await call('POST', '/_test/reset', { body: fx, base }); return r; }
async function tok(h, base = BASE) { return (await call('POST', '/auth/login', { body: { email: `${h}@example.com`, password: 'correct horse' }, base })).body.token; }
const me = async (t) => (await call('GET', '/me', { token: t })).body;
const auth = (t, body, key = k()) => call('POST', '/authorizations', { token: t, key, body });
const cap = (t, id, body, key = k()) => call('POST', `/authorizations/${id}/capture`, { token: t, key, body });
const vd = (t, id) => call('POST', `/authorizations/${id}/void`, { token: t });

(async () => {
  const FX = (extra = {}) => ({ currency: 'EUR', minor_units: 2, users: [U('ada', 10000), U('bob', 2500), U('cy', 500), U('op', 0)],
    settlement_operator_ids: ['u_op'], ...extra });
  let r = await reset(FX({ authorization_ttl_seconds: 2 }));
  check('reset ttl 2', r.status === 204, sc(r));
  let [ada, bob, cy, op] = await Promise.all(['ada', 'bob', 'cy', 'op'].map((h) => tok(h)));

  // /me shape with no holds
  let m = await me(ada);
  check('/me no holds', m.balance === 10000 && m.total === 10000 && m.available === 10000 && m.held === 0, JSON.stringify(m));

  // create
  r = await auth(ada, { to_handle: 'bob', amount: 2000, note: 'deposit', visibility: 'private' });
  check('authorize 201', r.status === 201, sc(r));
  const a1 = r.body;
  const keys = ['authorization_id', 'from_user_id', 'from_handle', 'to_user_id', 'to_handle', 'amount', 'captured_amount', 'currency', 'note', 'visibility', 'status', 'expires_at', 'payment_id', 'created_at', 'remaining_amount', 'payment_ids'];
  check('authorize shape', keys.every((x) => x in a1) && a1.status === 'open' && a1.captured_amount === 0 && a1.remaining_amount === 2000 && a1.payment_id === null && a1.payment_ids.length === 0, sc(r));
  check('expires_at = created_at + 2s', Date.parse(a1.expires_at) - Date.parse(a1.created_at) === 2000 && /[+-]\d\d:\d\d$/.test(a1.expires_at), `${a1.created_at} ${a1.expires_at}`);
  m = await me(ada);
  check('/me held 2000', m.total === 10000 && m.balance === 10000 && m.held === 2000 && m.available === 8000, JSON.stringify(m));
  r = await call('GET', '/activity', { token: ada });
  check('open auth not in feed', r.body.payments.length === 0, sc(r));
  // available checks everywhere
  r = await call('POST', '/payments', { token: ada, key: k(), body: { to_handle: 'cy', amount: 8001 } });
  check('payment > available -> 409', r.status === 409 && code(r) === 'insufficient_funds', sc(r));
  r = await auth(ada, { to_handle: 'cy', amount: 8001 });
  check('authorize > available -> 409', r.status === 409 && code(r) === 'insufficient_funds', sc(r));
  const rq = await call('POST', '/requests', { token: cy, key: k(), body: { payer_handle: 'ada', amount: 8001 } });
  r = await call('POST', `/requests/${rq.body.request_id}/pay`, { token: ada, key: k(), body: {} });
  check('request pay > available -> 409', r.status === 409 && code(r) === 'insufficient_funds', sc(r));
  r = await call('POST', '/settlements', { token: op, key: k(), body: { transfers: [{ from_handle: 'ada', to_handle: 'cy', amount: 8001 }] } });
  check('settlement net > available -> 409', r.status === 409, sc(r));
  r = await call('POST', '/settlements', { token: op, key: k(), body: { transfers: [{ from_handle: 'ada', to_handle: 'cy', amount: 9000 }, { from_handle: 'cy', to_handle: 'ada', amount: 1000 }] } });
  check('settlement net 8000 == available -> 201', r.status === 201, sc(r));
  m = await me(ada);
  check('ada available 0 after settlement', m.available === 0 && m.held === 2000 && m.total === 2000, JSON.stringify(m));
  // expiry by clock (ttl 2s): wait, then everything reflects expiry without a request at the deadline
  await sleep(2300);
  m = await me(ada);
  check('expired: held 0 available 2000', m.held === 0 && m.available === 2000, JSON.stringify(m));
  r = await call('GET', '/authorizations?status=expired', { token: ada });
  check('GET status=expired lists it', r.status === 200 && r.body.authorizations.length === 1 && r.body.authorizations[0].status === 'expired' && r.body.authorizations[0].remaining_amount === 0, sc(r));
  r = await call('GET', '/authorizations?status=open', { token: bob });
  check('GET status=open excludes clock-expired', r.body.authorizations.length === 0, sc(r));
  r = await cap(bob, a1.authorization_id, {});
  check('capture expired -> 409 authorization_expired', r.status === 409 && code(r) === 'authorization_expired', sc(r));
  r = await vd(ada, a1.authorization_id);
  check('void expired -> 409 not_open', r.status === 409 && code(r) === 'authorization_not_open', sc(r));

  // fresh state, long ttl
  await reset(FX());
  [ada, bob, cy, op] = await Promise.all(['ada', 'bob', 'cy', 'op'].map((h) => tok(h)));
  const A = (await auth(ada, { to_handle: 'bob', amount: 2000 })).body;
  check('default ttl 600', Date.parse(A.expires_at) - Date.parse(A.created_at) === 600000, A.expires_at);
  // permissions
  r = await cap(ada, A.authorization_id, {}); check('payer capture -> 403', r.status === 403, sc(r));
  r = await cap(cy, A.authorization_id, {}); check('third party capture -> 403', r.status === 403, sc(r));
  r = await vd(bob, A.authorization_id); check('receiver void -> 403', r.status === 403, sc(r));
  r = await vd(cy, A.authorization_id); check('third party void -> 403', r.status === 403, sc(r));
  r = await cap(bob, 'nope', {}); check('capture unknown -> 404', r.status === 404, sc(r));
  r = await vd(bob, 'nope'); check('void unknown -> 404', r.status === 404, sc(r));
  r = await call('GET', '/authorizations', { token: cy }); check('third party list empty', r.body.authorizations.length === 0, sc(r));
  // validation
  for (const [b, st, c] of [[{ final: 'yes' }, 400, 'malformed_request'], [{ final: null }, 400, 'malformed_request'], [{ amount: 0 }, 422, 'validation_failed'],
    [{ amount: 1.5 }, 422, 'validation_failed'], [{ amount: '5' }, 422, 'validation_failed'], [{ amount: true }, 422, 'validation_failed'],
    [{ amount: 2001 }, 422, 'capture_exceeds_authorization']]) {
    r = await cap(bob, A.authorization_id, b);
    check(`capture ${JSON.stringify(b)} -> ${st} ${c}`, r.status === st && code(r) === c, sc(r));
  }
  r = await call('POST', `/authorizations/${A.authorization_id}/capture`, { token: bob, body: {} });
  check('capture no key -> 400', r.status === 400 && code(r) === 'missing_idempotency_key', sc(r));
  // partial non-final captures
  const K1 = k();
  r = await cap(bob, A.authorization_id, { amount: 700, final: false }, K1);
  check('capture 700 nonfinal 201 payment shape', r.status === 201 && r.body.amount === 700 && r.body.authorization_id === A.authorization_id && r.body.request_id === null && r.body.settlement_id === null && 'payment_id' in r.body, sc(r));
  const P1 = r.body;
  r = await cap(bob, A.authorization_id, { final: false, amount: 700 }, K1);
  check('replay nonfinal 200 identical', r.status === 200 && JSON.stringify(r.body) === JSON.stringify(P1), sc(r));
  r = await cap(bob, A.authorization_id, { amount: 700 }, K1);
  check('replay with final omitted -> 409 reuse', r.status === 409 && code(r) === 'idempotency_key_reuse', sc(r));
  m = await me(ada);
  check('after 700: total 9300 held 1300 avail 8000', m.total === 9300 && m.held === 1300 && m.available === 8000, JSON.stringify(m));
  r = await call('GET', '/authorizations', { token: bob });
  let av = r.body.authorizations[0];
  check('auth open captured 700 remaining 1300', av.status === 'open' && av.captured_amount === 700 && av.remaining_amount === 1300 && av.payment_id === P1.payment_id && av.payment_ids.length === 1, JSON.stringify(av));
  r = await cap(bob, A.authorization_id, { amount: 1301, final: false });
  check('exceeds remainder -> 422 capture_exceeds', r.status === 422 && code(r) === 'capture_exceeds_authorization', sc(r));
  r = await cap(bob, A.authorization_id, { amount: 300, final: false });
  check('capture 300 nonfinal', r.status === 201, sc(r));
  const KD = k();
  r = await cap(bob, A.authorization_id, {}, KD);
  check('default capture takes remainder 1000', r.status === 201 && r.body.amount === 1000, sc(r));
  r = await cap(bob, A.authorization_id, { amount: 1000 }, KD);
  check('{} vs {amount:1000} -> 409 reuse', r.status === 409 && code(r) === 'idempotency_key_reuse', sc(r));
  r = await cap(bob, A.authorization_id, {}, KD);
  check('replay {} after closed -> 200', r.status === 200 && r.body.amount === 1000, sc(r));
  r = await cap(bob, A.authorization_id, {});
  check('capture closed -> 409 not_open', r.status === 409 && code(r) === 'authorization_not_open', sc(r));
  r = await vd(ada, A.authorization_id);
  check('void captured -> 409 not_open', r.status === 409 && code(r) === 'authorization_not_open', sc(r));
  r = await call('GET', '/authorizations?status=captured', { token: ada });
  av = r.body.authorizations[0];
  check('captured: cumulative 2000, 3 payment_ids, remaining 0', av && av.status === 'captured' && av.captured_amount === 2000 && av.payment_ids.length === 3 && av.remaining_amount === 0, JSON.stringify(av));
  m = await me(ada);
  check('ada total 8000 held 0', m.total === 8000 && m.held === 0 && m.available === 8000, JSON.stringify(m));
  r = await call('GET', '/activity', { token: cy });
  check('captures in feed by visibility (public)', r.body.payments.filter((p) => p.authorization_id === A.authorization_id).length === 3, sc(r));
  r = await call('POST', '/payments', { token: ada, key: k(), body: { to_handle: 'cy', amount: 1 } });
  check('plain payment authorization_id null', r.status === 201 && r.body.authorization_id === null, sc(r));

  // final capture of part releases remainder; private visibility copied
  const B = (await auth(ada, { to_handle: 'bob', amount: 1000, visibility: 'private', note: 'n😀' })).body;
  r = await cap(bob, B.authorization_id, { amount: 400 });
  check('final partial capture copies note/visibility', r.status === 201 && r.body.visibility === 'private' && r.body.note === 'n😀' && r.body.amount === 400, sc(r));
  m = await me(ada);
  check('remainder released', m.held === 0 && m.total === 7599, JSON.stringify(m));
  r = await call('GET', '/activity', { token: cy });
  check('private capture hidden from third party', !r.body.payments.some((p) => p.authorization_id === B.authorization_id), 'visible');
  // void partial
  const C = (await auth(ada, { to_handle: 'bob', amount: 1000 })).body;
  await cap(bob, C.authorization_id, { amount: 100, final: false });
  r = await vd(ada, C.authorization_id);
  check('void partial -> voided, remaining 0, captured kept', r.status === 200 && r.body.status === 'voided' && r.body.remaining_amount === 0 && r.body.captured_amount === 100 && r.body.payment_ids.length === 1, sc(r));
  r = await vd(ada, C.authorization_id);
  check('void again -> 200', r.status === 200 && r.body.status === 'voided', sc(r));
  r = await cap(bob, C.authorization_id, {});
  check('capture voided -> 409 not_open', r.status === 409 && code(r) === 'authorization_not_open', sc(r));
  // authorize validation and ordering
  for (const [b, st, c] of [[{ to_handle: 'ada', amount: 1 }, 422, 'self_payment'], [{ to_handle: 'BOB', amount: 1 }, 404, 'not_found'], [{ to_handle: 'BOB', amount: 0 }, 422, 'validation_failed'],
    [{ to_handle: 'bob', amount: 1, visibility: 'x' }, 422, 'validation_failed'], [{ to_handle: 'bob', amount: 1, note: 'x'.repeat(201) }, 422, 'validation_failed'],
    [{ to_handle: 5, amount: 1 }, 400, 'malformed_request'], [{ amount: 1 }, 422, 'validation_failed']]) {
    r = await auth(ada, b);
    check(`authorize ${JSON.stringify(b).slice(0, 50)} -> ${st}`, r.status === st && code(r) === c, sc(r));
  }
  r = await call('POST', '/authorizations', { token: ada, body: { to_handle: 'bob', amount: 1 } });
  check('authorize no key -> 400', r.status === 400, sc(r));
  const KA = k();
  r = await auth(ada, { to_handle: 'bob', amount: 5 }, KA);
  const r2 = await auth(ada, { amount: 5.0, to_handle: 'bob' }, KA);
  check('authorize replay 200 same', r2.status === 200 && JSON.stringify(r2.body) === JSON.stringify(r.body), sc(r2));
  r = await auth(ada, { to_handle: 'bob', amount: -1 }, KA);
  check('authorize claimed key invalid body -> 409', r.status === 409, sc(r));
  // list filters / paging
  for (const q of ['direction=x', 'status=OPEN', 'limit=0', 'limit=1e9', 'offset=-1', 'limit=4.0']) {
    r = await call('GET', '/authorizations?' + q, { token: ada }); check(`GET /authorizations?${q} -> 422`, r.status === 422, sc(r));
  }
  r = await call('GET', '/authorizations?direction=outgoing&limit=2', { token: ada });
  check('paging has_more', r.body.authorizations.length === 2 && r.body.has_more === true, sc(r));
  r = await call('GET', '/authorizations?direction=incoming', { token: ada });
  check('ada incoming empty', r.body.authorizations.length === 0, sc(r));
  r = await call('GET', '/authorizations', { token: ada });
  const cs = r.body.authorizations.map((x) => Date.parse(x.created_at));
  check('newest first', cs.every((c, i) => i === 0 || cs[i - 1] >= c), JSON.stringify(cs));
  r = await call('GET', '/authorizations');
  check('list no token 401', r.status === 401, sc(r));

  // concurrency: 50 concurrent captures with different keys of a 1000 hold, amount 100 nonfinal
  const D = (await auth(ada, { to_handle: 'bob', amount: 1000 })).body;
  const before = await me(ada), bbefore = await me(bob);
  const cr = await Promise.all(Array.from({ length: 50 }, () => cap(bob, D.authorization_id, { amount: 30, final: false })));
  check('concurrent captures no 5xx', cr.every((x) => x.status < 500), cr.map((x) => x.status).join());
  const ok = cr.filter((x) => x.status === 201).length;
  check('concurrent captures: exactly 33 (990 ≤ 1000)', ok === 33, ok);
  const after = await me(ada), bafter = await me(bob);
  check('money conserved and captured once', before.total - after.total === 990 && bafter.total - bbefore.total === 990 && before.held - after.held === 990, JSON.stringify(after));
  // concurrent authorize overspend
  const E0 = await me(cy);
  const ar = await Promise.all(Array.from({ length: 50 }, () => auth(cy, { to_handle: 'ada', amount: 37 })));
  const aok = ar.filter((x) => x.status === 201).length;
  check('authorize burst bounded by available', aok === Math.floor(E0.available / 37) && ar.every((x) => x.status < 500), `${aok} vs ${E0.available}`);
  const pr = await Promise.all(Array.from({ length: 20 }, () => call('POST', '/payments', { token: cy, key: k(), body: { to_handle: 'ada', amount: 1 } })));
  const Ec = await me(cy);
  check('cy available never negative', Ec.available >= 0 && Ec.available === E0.available - aok * 37 - pr.filter((x) => x.status === 201).length, JSON.stringify(Ec));

  // fixture
  const now = Date.now();
  const SA = (o) => ({ id: 'a_s', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 2000, status: 'open', expires_at: iso(now + 2 * H), ...o });
  r = await reset(FX({ authorizations: [SA({}), SA({ id: 'a_past', expires_at: iso(now - 2 * H), amount: 99999 }), SA({ id: 'a_v', status: 'voided', amount: 99999 }),
    SA({ id: 'a_c', status: 'captured' }), SA({ id: 'a_off', expires_at: '2099-01-01T05:00:00+05:00', amount: 100, from_user_id: 'u_bob', to_user_id: 'u_cy', captured_amount: 40 })] }));
  check('seeded fixture accepted', r.status === 204, sc(r));
  [ada, bob, cy] = await Promise.all(['ada', 'bob', 'cy'].map((h) => tok(h)));
  m = await me(ada);
  check('seeded open counts, past-open and voided do not', m.held === 2000 && m.available === 8000 && m.total === 10000, JSON.stringify(m));
  m = await me(bob);
  check('seeded partial captured_amount reduces hold', m.held === 60 && m.available === 2440, JSON.stringify(m));
  r = await call('GET', '/authorizations?limit=200', { token: ada });
  const by = Object.fromEntries(r.body.authorizations.map((x) => [x.authorization_id, x]));
  check('seeded past open shows expired', by.a_past && by.a_past.status === 'expired' && by.a_past.remaining_amount === 0, JSON.stringify(by.a_past));
  check('seeded captured defaults captured_amount = amount', by.a_c && by.a_c.captured_amount === 2000 && by.a_c.remaining_amount === 0, JSON.stringify(by.a_c));
  check('seeded expires_at returned with offset', by.a_s && /[+-]\d\d:\d\d$|Z$/.test(by.a_s.expires_at), JSON.stringify(by.a_s));
  r = await cap(bob, 'a_s', { amount: 500, final: false });
  check('capture seeded hold', r.status === 201, sc(r));
  r = await reset(FX({ authorizations: [SA({ amount: 6000 }), SA({ id: 'a2', amount: 4001 })] }));
  check('seeded open sum > balance -> 422', r.status === 422 && code(r) === 'validation_failed', sc(r));
  r = await call('GET', '/me', { token: ada });
  check('state unchanged after 422', r.status === 200 && r.body.held === 1500, sc(r));
  r = await reset(FX({ authorizations: [SA({ amount: 6000, expires_at: iso(now - 2 * H) }), SA({ id: 'a2', amount: 10000 })] }));
  check('expired holds excluded from sum check', r.status === 204, sc(r));
  for (const [nm, f] of [['ttl 0', FX({ authorization_ttl_seconds: 0 })], ['ttl 1.5', FX({ authorization_ttl_seconds: 1.5 })], ['ttl "600"', FX({ authorization_ttl_seconds: '600' })],
    ['ttl true', FX({ authorization_ttl_seconds: true })], ['bad status', FX({ authorizations: [SA({ status: 'pending' })] })], ['bad expires', FX({ authorizations: [SA({ expires_at: 'tomorrow' })] })],
    ['no offset', FX({ authorizations: [SA({ expires_at: '2099-01-01T00:00:00' })] })], ['self auth', FX({ authorizations: [SA({ to_user_id: 'u_ada' })] })],
    ['unknown user', FX({ authorizations: [SA({ to_user_id: 'u_zz' })] })], ['dup id', FX({ authorizations: [SA({ amount: 1 }), SA({ amount: 1 })] })],
    ['amount 0', FX({ authorizations: [SA({ amount: 0 })] })], ['captured > amount', FX({ authorizations: [SA({ captured_amount: 2001 })] })],
    ['authorizations not array', FX({ authorizations: {} })]]) {
    r = await reset(f); check(`fixture ${nm} -> 422`, r.status === 422, sc(r));
  }
  r = await reset(FX({ authorization_ttl_seconds: 600.0 }));
  check('ttl 600.0 accepted', r.status === 204, sc(r));

  // export / import round trip with holds
  await reset(FX());
  [ada, bob] = await Promise.all(['ada', 'bob'].map((h) => tok(h)));
  const G = (await auth(ada, { to_handle: 'bob', amount: 3000 })).body;
  const KG = k();
  const g1 = await cap(bob, G.authorization_id, { amount: 1000, final: false }, KG);
  const ex = await call('GET', '/_test/export');
  check('export has authorizations', ex.status === 200 && JSON.stringify(ex.body).includes(G.authorization_id), sc(ex));
  await cap(bob, G.authorization_id, {});
  r = await call('POST', '/_test/import', { body: ex.body });
  check('import 204', r.status === 204, sc(r));
  m = await me(ada);
  check('import restores hold', m.held === 2000 && m.total === 9000, JSON.stringify(m));
  r = await cap(bob, G.authorization_id, { amount: 1000, final: false }, KG);
  check('capture replay after import', r.status === 200 && JSON.stringify(r.body) === JSON.stringify(g1.body), sc(r));
  for (const bad of [{ authorizations: 'x' }, { authorizations: [{}] }, { authorization_ttl_seconds: 0 }]) {
    r = await call('POST', '/_test/import', { body: { ...ex.body, state: { ...ex.body.state, ...bad } } });
    check(`bad import ${JSON.stringify(bad).slice(0, 30)} -> 422`, r.status === 422, sc(r));
  }
  m = await me(ada); check('state unchanged after bad imports', m.held === 2000, JSON.stringify(m));

  // REAL stage-1 container export -> stage-2 import
  if (S1BASE) {
    await reset({ ...FX(), requests: [{ id: 'rq_1', requester_id: 'u_bob', payer_id: 'u_ada', amount: 1200, note: 'taxi' }] }, S1BASE);
    const t1 = await tok('ada', S1BASE);
    const KP = 'lost-before-export';
    const pay1 = await call('POST', '/payments', { token: t1, key: KP, body: { to_handle: 'bob', amount: 150, note: 'x' }, base: S1BASE });
    const ex1 = await call('GET', '/_test/export', { base: S1BASE });
    r = await call('POST', '/_test/import', { body: ex1.body });
    check('stage-1 export imports into stage-2', r.status === 204, sc(r));
    m = await me(t1);
    check('stage-1 token valid, /me has new fields', m && m.total === 9850 && m.available === 9850 && m.held === 0, JSON.stringify(m));
    r = await call('POST', '/payments', { token: t1, key: KP, body: { to_handle: 'bob', amount: 150, note: 'x' } });
    check('stage-1 lost payment retry -> 200 original body verbatim', r.status === 200 && JSON.stringify(r.body) === JSON.stringify(pay1.body), sc(r));
    r = await call('POST', '/requests/rq_1/pay', { token: t1, key: k(), body: {} });
    check('stage-1 pending request payable', r.status === 201 && r.body.authorization_id === null, sc(r));
    r = await auth(t1, { to_handle: 'bob', amount: 100 });
    check('authorize after stage-1 import uses ttl 600', r.status === 201 && Date.parse(r.body.expires_at) - Date.parse(r.body.created_at) === 600000, sc(r));
    r = await call('GET', '/activity', { token: t1 });
    check('imported stage-1 payments carry authorization_id null', r.body.payments.every((p) => 'authorization_id' in p), sc(r));
  }

  // no stage-3 features
  ada = await tok('ada'); r = await call('GET', '/statements', { token: ada }); check('no /statements', r.status === 404, sc(r));
  r = await call('GET', '/me?as_of=2020-01-01T00:00:00Z', { token: ada }); check('as_of ignored', r.status === 200 && !('as_of' in r.body), sc(r));

  console.log(out.join('\n'));
  console.log(`${pass} passed, ${fail} failed`);
})().catch((e) => { console.error(e); process.exit(2); });
