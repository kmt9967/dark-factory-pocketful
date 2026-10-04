'use strict';
// Reviewer round-2 probes for W2a (rev feb582e): E4a fixes for F1 (open hold without remainder)
// and F2 (import holds vs balances).
// Usage: BASE=http://127.0.0.1:19090 node stage-2/review/rev-w2a-r2-probe.js
const BASE = process.env.BASE || 'http://127.0.0.1:19090';
let pass = 0, fail = 0; const out = [];
const check = (n, c, d) => { if (c) pass++; else { fail++; out.push(`FAIL ${n} :: ${d}`); } };
async function call(method, p, { body, token, key } = {}) {
  const h = {};
  if (token) h.authorization = `Bearer ${token}`;
  if (key !== undefined) h['idempotency-key'] = key;
  const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  return { status: r.status, body: j };
}
const code = (r) => r.body && r.body.error && r.body.error.code;
const sc = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`;
const U = (h, bal) => ({ id: `u_${h}`, email: `${h}@example.com`, password: 'correct horse', display_name: h, handle: h, balance: bal });
const iso = (ms) => new Date(ms).toISOString().replace('Z', '+00:00');
const H = 3600e3;
const tok = async (h) => (await call('POST', '/auth/login', { body: { email: `${h}@example.com`, password: 'correct horse' } })).body.token;
const FX = (auths) => ({ currency: 'EUR', minor_units: 2, users: [U('ada', 100), U('bob', 0)], authorizations: auths });
const A = (o) => ({ id: 'a1', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 50, status: 'open', expires_at: iso(Date.now() + 2 * H), ...o });

(async () => {
  // F1 fixture side
  let r = await call('POST', '/_test/reset', { body: FX([A({ captured_amount: 10 })]) });
  check('baseline reset', r.status === 204, sc(r));
  const base = await tok('ada');
  r = await call('POST', '/_test/reset', { body: FX([A({ captured_amount: 50 })]) });
  check('F1 open captured==amount -> 422', r.status === 422 && code(r) === 'validation_failed', sc(r));
  r = await call('GET', '/me', { token: base });
  check('F1 state unchanged (held 40)', r.status === 200 && r.body.held === 40, sc(r));
  r = await call('POST', '/_test/reset', { body: FX([A({ captured_amount: 49 })]) });
  check('open captured 49/50 ok', r.status === 204, sc(r));
  const bob = await tok('bob');
  r = await call('POST', '/authorizations/a1/capture', { token: bob, key: 'c1', body: {} });
  check('capture remaining 1', r.status === 201 && r.body.amount === 1, sc(r));
  r = await call('POST', '/authorizations/a1/capture', { token: bob, key: 'c2', body: {} });
  check('then not_open', r.status === 409 && code(r) === 'authorization_not_open', sc(r));
  for (const st of ['captured', 'voided', 'expired']) {
    r = await call('POST', '/_test/reset', { body: FX([A({ status: st, captured_amount: 50 })]) });
    check(`${st} captured==amount accepted`, r.status === 204, sc(r));
  }

  // F2 import side
  r = await call('POST', '/_test/reset', { body: FX([]) });
  const ada = await tok('ada');
  const ex = (await call('GET', '/_test/export')).body;
  const imp = (auths, users) => call('POST', '/_test/import', { body: { ...ex, state: { ...ex.state, authorizations: auths, ...(users ? { users } : {}) } } });
  const IA = (o) => ({ id: 'a9', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 60, captured_amount: 0, payment_ids: [], note: '', visibility: 'public',
    status: 'open', expires_at: iso(Date.now() + 2 * H), created_at: iso(Date.now()), ...o });
  r = await imp([IA({ amount: 5000 })]);
  check('F2 single over-balance hold -> 422', r.status === 422, sc(r));
  r = await imp([IA({}), IA({ id: 'a10' })]);
  check('F2 two holds jointly 120 > 100 -> 422', r.status === 422, sc(r));
  r = await call('GET', '/me', { token: ada });
  check('F2 state unchanged', r.status === 200 && r.body.held === 0 && r.body.total === 100, sc(r));
  r = await imp([IA({}), IA({ id: 'a10', amount: 40 })]);
  check('two holds exactly 100 -> 204', r.status === 204, sc(r));
  r = await call('GET', '/me', { token: ada });
  check('held 100 available 0', r.body.held === 100 && r.body.available === 0, sc(r));
  r = await imp([IA({ amount: 5000, expires_at: iso(Date.now() - 2 * H) })]);
  check('past-expired over-balance hold accepted', r.status === 204, sc(r));
  r = await call('GET', '/authorizations', { token: ada });
  check('...and shows expired', r.body.authorizations[0].status === 'expired', sc(r));
  r = await imp([IA({ amount: 5000, status: 'voided' })]);
  check('voided over-balance accepted', r.status === 204, sc(r));
  r = await imp([IA({ captured_amount: 60 })]);
  check('import open captured==amount -> 422', r.status === 422, sc(r));
  r = await imp([IA({ amount: 5000, captured_amount: 4950 })]);
  check('import open partial with remainder 50 <= 100 -> 204', r.status === 204, sc(r));
  r = await imp([IA({ note: 'x'.repeat(201) })]);
  check('import note > 200 -> 422', r.status === 422, sc(r));
  r = await imp([IA({ payment_ids: [''] })]);
  check('import empty payment id -> 422', r.status === 422, sc(r));
  const negUsers = ex.state.users.map((u) => (u.id === 'u_bob' ? { ...u, balance: -1 } : u));
  r = await imp([], negUsers);
  check('import negative balance -> 422', r.status === 422, sc(r));
  r = await call('POST', '/_test/import', { body: ex });
  check('plain export still imports', r.status === 204, sc(r));

  console.log(out.join('\n'));
  console.log(`${pass} passed, ${fail} failed`);
})().catch((e) => { console.error(e); process.exit(2); });
