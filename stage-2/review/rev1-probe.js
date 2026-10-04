'use strict';
// Reviewer probes for W1 (rev 2bd7c4b). Runs against a live service.
// Usage: BASE=http://127.0.0.1:19090 node stage-1/review/rev1-probe.js
const BASE = process.env.BASE || 'http://127.0.0.1:19090';
let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) pass++; else { fail++; results.push(`FAIL ${name} :: ${detail}`); }
}
async function call(method, p, { body, raw, token, key, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (key !== undefined) h['idempotency-key'] = key;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const t0 = Date.now();
  const r = await fetch(BASE + p, { method, headers: h, body: payload });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, body: json, ms: Date.now() - t0, ctype: r.headers.get('content-type') };
}
const code = (r) => r.body && r.body.error && r.body.error.code;
const sc = (r) => `${r.status} ${code(r) || ''} ${JSON.stringify(r.body).slice(0, 160)}`;
let kn = 0; const k = () => `rk${Date.now()}_${kn++}`;
const U = (h, bal) => ({ id: `u_${h}`, email: `${h}@example.com`, password: 'correct horse', display_name: h, handle: h, balance: bal });
const FX = (extra = {}) => ({ currency: 'EUR', minor_units: 2,
  users: [U('ada', 10000), U('bob', 2500), U('cy', 500), U('op', 0)], settlement_operator_ids: ['u_op'], ...extra });
async function reset(fx = FX()) { const r = await call('POST', '/_test/reset', { body: fx }); if (r.status !== 204) throw new Error('reset ' + sc(r)); }
async function login(h) { return (await call('POST', '/auth/login', { body: { email: `${h}@example.com`, password: 'correct horse' } })).body.token; }
async function total(tokens) { let s = 0; for (const t of tokens) s += (await call('GET', '/me', { token: t })).body.balance; return s; }

(async () => {
  await reset();
  const [ada, bob, cy, op] = await Promise.all(['ada', 'bob', 'cy', 'op'].map(login));

  // --- D11: string handles matching no user -> 404 (after field validation)
  for (const h of ['BOB', 'no-such', '', 'x'.repeat(30), 'nosuch']) {
    let r = await call('POST', '/payments', { token: ada, key: k(), body: { to_handle: h, amount: 100 } });
    check(`D11 payments to_handle=${JSON.stringify(h)} -> 404`, r.status === 404 && code(r) === 'not_found', sc(r));
    r = await call('POST', '/requests', { token: ada, key: k(), body: { payer_handle: h, amount: 100 } });
    check(`D11 requests payer_handle=${JSON.stringify(h)} -> 404`, r.status === 404, sc(r));
    r = await call('POST', '/splits', { token: ada, key: k(), body: { participant_handles: ['bob', h], amount: 100 } });
    check(`D11 splits participant=${JSON.stringify(h)} -> 404`, r.status === 404, sc(r));
    r = await call('POST', '/settlements', { token: op, key: k(), body: { transfers: [{ from_handle: 'ada', to_handle: h, amount: 1 }] } });
    check(`D11 settlement to_handle=${JSON.stringify(h)} -> 404`, r.status === 404, sc(r));
  }
  // field validation precedes 404 (D2)
  let r = await call('POST', '/payments', { token: ada, key: k(), body: { to_handle: 'BOB', amount: 0 } });
  check('D2 bad amount + malformed handle -> 422', r.status === 422, sc(r));

  // --- typing
  r = await call('POST', '/payments', { token: ada, key: k(), body: { to_handle: 5, amount: 1 } });
  check('to_handle number -> 400', r.status === 400 && code(r) === 'malformed_request', sc(r));
  r = await call('POST', '/payments', { token: ada, key: k(), body: { to_handle: null, amount: 1 } });
  check('to_handle null -> 400', r.status === 400, sc(r));
  r = await call('POST', '/payments', { token: ada, key: k(), body: { amount: 1 } });
  check('to_handle missing -> 422', r.status === 422, sc(r));
  for (const a of ['1000', true, null, 1.5, -1, 0, 1000000001, [1], { a: 1 }]) {
    r = await call('POST', '/payments', { token: ada, key: k(), body: { to_handle: 'bob', amount: a } });
    check(`amount ${JSON.stringify(a)} -> 422`, r.status === 422, sc(r));
  }
  r = await call('POST', '/payments', { token: ada, key: k(), raw: '{"to_handle":"bob","amount":1e400}', headers: { 'content-type': 'application/json' } });
  check('amount 1e400 -> 422', r.status === 422, sc(r));
  r = await call('POST', '/payments', { token: ada, key: k(), raw: '{"to_handle":"bob","amount":10e0,"note":null}' });
  check('note null -> 422', r.status === 422, sc(r));
  r = await call('POST', '/payments', { token: ada, key: k(), body: { to_handle: 'bob', amount: 1, visibility: null } });
  check('visibility null -> 422', r.status === 422, sc(r));
  for (const raw of ['', 'null', '[]', '1', '"x"', '{', '\xff\xfe']) {
    r = await call('POST', '/payments', { token: ada, key: k(), raw });
    check(`body ${JSON.stringify(raw)} -> 400`, r.status === 400 && code(r) === 'malformed_request', sc(r));
  }
  // emoji note 200 code points ok, 201 -> 422; verbatim
  const note200 = '👍'.repeat(200);
  r = await call('POST', '/payments', { token: ada, key: k(), body: { to_handle: 'bob', amount: 1, note: note200 } });
  check('note 200 emoji -> 201 verbatim', r.status === 201 && r.body.note === note200, sc(r));
  r = await call('POST', '/payments', { token: ada, key: k(), body: { to_handle: 'bob', amount: 1, note: note200 + 'x' } });
  check('note 201 cp -> 422', r.status === 422, sc(r));
  const weird = '  e\u0301 \u00e9 <b>&amp;</b> \\n\n\t\u200d👨‍👩‍👧 ';
  r = await call('POST', '/payments', { token: ada, key: k(), body: { to_handle: 'bob', amount: 1, note: weird } });
  check('note verbatim', r.status === 201 && r.body.note === weird, sc(r));

  // --- idempotency
  const K1 = k();
  const r1 = await call('POST', '/payments', { token: ada, key: K1, body: { to_handle: 'bob', amount: 7 } });
  const r2 = await call('POST', '/payments', { token: ada, key: K1, raw: ' { "amount" : 7.0 , "to_handle":"bob" } ' });
  check('replay reordered/7.0 -> 200 same body', r2.status === 200 && JSON.stringify(r2.body) === JSON.stringify(r1.body), sc(r2));
  r = await call('POST', '/payments', { token: ada, key: K1, body: { to_handle: 'bob', amount: -5 } });
  check('claimed key + invalid body -> 409', r.status === 409 && code(r) === 'idempotency_key_reuse', sc(r));
  r = await call('POST', '/payments', { token: bob, key: K1, body: { to_handle: 'ada', amount: 7 } });
  check('same key other user -> 201', r.status === 201, sc(r));
  r = await call('POST', '/payments', { token: ada, key: 'x'.repeat(256), body: { to_handle: 'bob', amount: 1 } });
  check('key 256 -> 422', r.status === 422, sc(r));
  r = await call('POST', '/payments', { token: ada, key: 'y'.repeat(255), body: { to_handle: 'bob', amount: 1 } });
  check('key 255 -> 201', r.status === 201, sc(r));
  r = await call('POST', '/payments', { token: ada, body: { to_handle: 'bob', amount: 1 } });
  check('no key -> 400', r.status === 400 && code(r) === 'missing_idempotency_key', sc(r));
  r = await call('POST', '/payments', { key: k(), body: { to_handle: 'bob', amount: 1 } });
  check('no token -> 401', r.status === 401, sc(r));
  r = await call('POST', '/payments', { token: 'nope', body: { to_handle: 'bob', amount: 1 } });
  check('bad token no key -> 401', r.status === 401, sc(r));
  // failed key reusable
  const KF = k();
  r = await call('POST', '/payments', { token: cy, key: KF, body: { to_handle: 'ada', amount: 100000 } });
  check('cy short -> 409 insufficient', r.status === 409 && code(r) === 'insufficient_funds', sc(r));
  r = await call('POST', '/payments', { token: cy, key: KF, body: { to_handle: 'ada', amount: 1 } });
  check('failed key reused different body -> 201', r.status === 201, sc(r));

  // request lifecycle & replay after state change
  const KR = k();
  const rq = await call('POST', '/requests', { token: bob, key: KR, body: { payer_handle: 'ada', amount: 50 } });
  check('request 201', rq.status === 201 && rq.body.status === 'pending', sc(rq));
  r = await call('POST', `/requests/${rq.body.request_id}/cancel`, { token: bob });
  check('cancel 200', r.status === 200 && r.body.status === 'cancelled', sc(r));
  r = await call('POST', '/requests', { token: bob, key: KR, body: { payer_handle: 'ada', amount: 50 } });
  check('replay after cancel -> 200 pending original', r.status === 200 && r.body.status === 'pending', sc(r));
  r = await call('POST', `/requests/${rq.body.request_id}/pay`, { token: ada, key: k(), body: {} });
  check('pay cancelled -> 409 not pending', r.status === 409 && code(r) === 'request_not_pending', sc(r));
  r = await call('POST', `/requests/${rq.body.request_id}/decline`, { token: ada });
  check('decline cancelled -> 409', r.status === 409, sc(r));
  r = await call('POST', `/requests/${rq.body.request_id}/pay`, { token: cy, key: k(), body: {} });
  check('third party pay -> 403', r.status === 403, sc(r));
  r = await call('POST', `/requests/nosuch/pay`, { token: cy, key: k(), body: {} });
  check('unknown pay -> 404', r.status === 404, sc(r));
  const rq2 = await call('POST', '/requests', { token: bob, key: k(), body: { payer_handle: 'ada', amount: 60 } });
  const KP = k();
  const p1 = await call('POST', `/requests/${rq2.body.request_id}/pay`, { token: ada, key: KP, body: {} });
  check('pay 201', p1.status === 201 && p1.body.request_id === rq2.body.request_id, sc(p1));
  r = await call('POST', `/requests/${rq2.body.request_id}/pay`, { token: ada, key: KP, raw: '' });
  check('pay replay empty body == {} -> 200', r.status === 200, sc(r));
  r = await call('POST', `/requests/${rq2.body.request_id}/pay`, { token: ada, key: KP, body: { visibility: 'public' } });
  check('pay replay {visibility:public} vs {} -> 409', r.status === 409 && code(r) === 'idempotency_key_reuse', sc(r));
  // same key same body different path -> new request
  const rq3 = await call('POST', '/requests', { token: bob, key: k(), body: { payer_handle: 'ada', amount: 61 } });
  r = await call('POST', `/requests/${rq3.body.request_id}/pay`, { token: ada, key: KP, body: {} });
  check('same key/body different path -> 201', r.status === 201, sc(r));

  // query params
  for (const q of ['limit=1e9', 'limit=4.0', 'limit=+4', 'limit=0', 'limit=201', 'offset=-1', 'limit=', 'offset=1.0', 'direction=in', 'status=PAID']) {
    r = await call('GET', '/requests?' + q, { token: ada });
    check(`GET /requests?${q} -> 422`, r.status === 422, sc(r));
  }
  r = await call('GET', '/activity?limit=200&offset=999999999999&foo=bar', { token: ada });
  check('activity big offset -> 200 empty', r.status === 200 && r.body.payments.length === 0 && r.body.has_more === false, sc(r));

  // privacy: operator sees no others' private payments
  await call('POST', '/payments', { token: ada, key: k(), body: { to_handle: 'bob', amount: 3, visibility: 'private', note: 'secret' } });
  const actOp = await call('GET', '/activity?limit=200', { token: op });
  check('operator not seeing private', actOp.body.payments.every((p) => p.visibility === 'public'), sc(actOp));
  const actBob = await call('GET', '/activity?limit=200', { token: bob });
  check('receiver sees private', actBob.body.payments.some((p) => p.note === 'secret'), 'missing');
  r = await call('GET', '/requests?limit=200', { token: op });
  check('operator sees no requests', r.body.requests.length === 0, sc(r));

  // settlements
  r = await call('POST', '/settlements', { token: ada, key: k(), body: { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 1 }] } });
  check('non-operator settlement -> 403', r.status === 403, sc(r));
  r = await call('POST', '/settlements', { key: k(), body: {} });
  check('no token settlement -> 401', r.status === 401, sc(r));
  const before = await total([ada, bob, cy, op]);
  r = await call('POST', '/settlements', { token: op, key: k(), body: { transfers: [
    { from_handle: 'op', to_handle: 'cy', amount: 1000000000 }, { from_handle: 'cy', to_handle: 'op', amount: 1000000000 }] } });
  check('net-zero chain from 0 balance -> 201', r.status === 201, sc(r));
  const sres = r;
  check('settlement members created_at==committed_at & settlement_id', r.status === 201 && r.body.payments.every((p) => p.created_at === r.body.committed_at && p.settlement_id === r.body.settlement_id && p.request_id === null), sc(r));
  r = await call('POST', '/settlements', { token: op, key: k(), body: { transfers: [
    { from_handle: 'ada', to_handle: 'bob', amount: 1 }, { from_handle: 'nosuch', to_handle: 'bob', amount: 1 }, { from_handle: 'ada', to_handle: 'ada', amount: 1 }] } });
  check('entry error order: unknown first -> 404', r.status === 404, sc(r));
  r = await call('POST', '/settlements', { token: op, key: k(), body: { transfers: [
    { from_handle: 'ada', to_handle: 'ada', amount: 1 }, { from_handle: 'nosuch', to_handle: 'bob', amount: 1 }] } });
  check('entry error order: self first -> 422 self_payment', r.status === 422 && code(r) === 'self_payment', sc(r));
  r = await call('POST', '/settlements', { token: op, key: k(), body: { transfers: [
    { from_handle: 'cy', to_handle: 'bob', amount: 999999 }, { from_handle: 'ada', to_handle: 'nosuch', amount: 1 }] } });
  check('entry error beats funds -> 404', r.status === 404, sc(r));
  r = await call('POST', '/settlements', { token: op, key: k(), body: { transfers: [{ from_handle: 'cy', to_handle: 'bob', amount: 999999 }] } });
  check('unaffordable -> 409', r.status === 409 && code(r) === 'insufficient_funds', sc(r));
  for (const t of [[], Array(33).fill({ from_handle: 'ada', to_handle: 'bob', amount: 1 }), 'x', null, [1]]) {
    r = await call('POST', '/settlements', { token: op, key: k(), body: { transfers: t } });
    check(`settlement transfers=${JSON.stringify(t).slice(0, 30)} -> 422`, r.status === 422, sc(r));
  }
  check('total conserved after settlements', (await total([ada, bob, cy, op])) === before, 'changed');

  // signup
  r = await call('POST', '/auth/signup', { body: { email: 'Zoë.Smith+tag@Example.com', password: '12345678', display_name: 'Z' } });
  check('signup 201', r.status === 201, sc(r));
  const zt = r.body.token;
  r = await call('GET', '/me', { token: zt });
  check('derived handle zo__smith_tag', r.body.handle === 'zo__smith_tag' && r.body.balance === 0, sc(r));
  r = await call('POST', '/auth/signup', { body: { email: 'ADA@example.com', password: '12345678', display_name: 'A' } });
  check('email case-insens -> 409 email_taken', r.status === 409 && code(r) === 'email_taken', sc(r));
  r = await call('POST', '/auth/signup', { body: { email: 'ada@other.com', password: '12345678', display_name: 'A' } });
  check('handle taken -> 409', r.status === 409 && code(r) === 'handle_taken', sc(r));
  r = await call('POST', '/auth/login', { body: { email: 'ada@other.com', password: '12345678' } });
  check('no account after handle_taken', r.status === 401, sc(r));
  r = await call('POST', '/auth/signup', { body: { email: 'abcdefghijklmnopqrstuvwxyz@x.com', password: '1234567', display_name: 'A' } });
  check('pw 7 -> 422', r.status === 422, sc(r));
  r = await call('POST', '/auth/signup', { body: { email: 'abcdefghijklmnopqrstuvwxyz@x.com', password: '12345678' } });
  check('signup without display_name (spec silent) -> 201?', r.status === 201, sc(r));
  for (const e of ['nope', '@x.com', 'a@', 'a@@b', 'a b@c']) {
    r = await call('POST', '/auth/signup', { body: { email: e, password: '12345678', display_name: 'A' } });
    check(`email ${e} -> 422`, r.status === 422, sc(r));
  }

  // export / import
  const ex = await call('GET', '/_test/export');
  check('export shape', ex.status === 200 && ex.body.track === 'pocketful' && ex.body.format_version === 1, sc(ex));
  check('no plaintext password in export', !JSON.stringify(ex.body).includes('correct horse'), 'plaintext found');
  await call('POST', '/payments', { token: ada, key: k(), body: { to_handle: 'bob', amount: 1 } });
  const ex2 = await call('GET', '/_test/export');
  check('export snapshot not affected', JSON.stringify(ex.body) !== JSON.stringify(ex2.body), 'same');
  for (const bad of [{}, { ...ex.body, track: 'x' }, { ...ex.body, format_version: 2 }, { track: 'pocketful', format_version: 1 },
    { ...ex.body, state: { ...ex.body.state, users: 'x' } }, { ...ex.body, state: { ...ex.body.state, users: [null] } },
    { ...ex.body, state: { ...ex.body.state, tokens: [[1, 2, 3]] } }, { ...ex.body, state: { ...ex.body.state, payments: [{}] } }]) {
    r = await call('POST', '/_test/import', { body: bad });
    check('bad import -> 422', r.status === 422, sc(r));
  }
  r = await call('GET', '/me', { token: ada });
  check('state unchanged after bad imports', r.status === 200, sc(r));
  r = await call('POST', '/_test/import', { raw: '{bad' });
  check('import bad json -> 400', r.status === 400, sc(r));
  r = await call('POST', '/_test/import', { body: ex.body });
  check('import 204', r.status === 204, sc(r));
  r = await call('POST', '/_test/import', { body: ex.body });
  check('import again 204', r.status === 204, sc(r));
  const ex3 = await call('GET', '/_test/export');
  { const n = (e) => JSON.stringify({ ...e.state, used_ids: [...e.state.used_ids].sort() }); check('import is exact (re-export equals, used_ids order-insensitive)', n(ex3.body) === n(ex.body), 'differs'); }
  r = await call('POST', '/payments', { token: ada, key: K1, body: { to_handle: 'bob', amount: 7 } });
  check('replay after import -> 200 original', r.status === 200 && JSON.stringify(r.body) === JSON.stringify(r1.body), sc(r));
  r = await call('POST', '/auth/login', { body: { email: 'zoë.smith+tag@example.com', password: '12345678' } });
  check('signup user login after import', r.status === 200, sc(r));

  // concurrency: overspend burst, concurrent identical keys
  await reset();
  const [a2, b2, c2] = await Promise.all(['ada', 'bob', 'cy'].map(login));
  const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => call('POST', '/payments', { token: c2, key: 'burst' + i, body: { to_handle: 'ada', amount: 37 } })));
  check('burst: no 5xx', rs.every((x) => x.status < 500), rs.map((x) => x.status).join());
  check('burst: 13 succeed', rs.filter((x) => x.status === 201).length === 13, rs.filter((x) => x.status === 201).length);
  check('burst: total conserved', (await total([a2, b2, c2])) === 13000, 'total');
  const same = await Promise.all(Array.from({ length: 50 }, () => call('POST', '/splits', { token: a2, key: 'S', body: { amount: 10, participant_handles: ['bob', 'ada', 'cy'] } })));
  check('concurrent identical split: one 201', same.filter((x) => x.status === 201).length === 1 && same.filter((x) => x.status === 200).length === 49, same.map((x) => x.status).join());
  r = await call('GET', '/requests?direction=outgoing', { token: a2 });
  check('split created exactly 2 requests', r.body.requests.length === 2 && r.body.requests.map((q) => q.amount).sort().join() === '3,4', sc(r));

  // timing: 50 concurrent logins, big reset
  let t0 = Date.now();
  const ls = await Promise.all(Array.from({ length: 50 }, () => call('POST', '/auth/login', { body: { email: 'ada@example.com', password: 'correct horse' } })));
  const maxMs = Math.max(...ls.map((x) => x.ms));
  check('50 concurrent logins each < 5s', ls.every((x) => x.status === 200) && maxMs < 5000, `max ${maxMs} ms`);
  console.log(`50 logins: max ${maxMs} ms, wall ${Date.now() - t0} ms`);
  const big = { currency: 'JPY', minor_units: 0, users: Array.from({ length: 1000 }, (_, i) => U('u' + i, 5)) };
  t0 = Date.now();
  r = await call('POST', '/_test/reset', { body: big });
  console.log(`reset 1000 users: ${r.status} ${Date.now() - t0} ms`);
  check('reset 1000 users < 10s', r.status === 204 && Date.now() - t0 < 10000, sc(r));

  // fixture validation
  await reset();
  const fxs = [
    FX({ users: [U('ada', -1)] }), FX({ users: [U('ada', 1), U('ada', 2)] }), FX({ minor_units: 1 }),
    FX({ users: [{ ...U('ada', 1), handle: 'Ada' }] }), FX({ payments: [{ id: 'p', from_user_id: 'u_ada', to_user_id: 'u_zz', amount: 1 }] }),
    FX({ settlement_operator_ids: ['u_zz'] }),
  ];
  for (const f of fxs) {
    r = await call('POST', '/_test/reset', { body: f });
    check('bad fixture -> 422', r.status === 422, sc(r));
  }
  r = await call('GET', '/me', { token: await login('ada') });
  check('state intact after bad fixtures', r.status === 200 && r.body.balance === 10000, sc(r));

  r = await call('GET', '/nope');
  check('unknown route 404 json', r.status === 404 && code(r) === 'not_found', sc(r));
  r = await call('POST', '/requests/%E0%A4%A/pay', { token: ada, key: k(), body: {} });
  check('bad percent-encoding no 5xx', r.status < 500, sc(r));

  console.log(results.join('\n'));
  console.log(`${pass} passed, ${fail} failed`);
})().catch((e) => { console.error(e); process.exit(2); });
