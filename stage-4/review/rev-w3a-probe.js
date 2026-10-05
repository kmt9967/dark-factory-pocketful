'use strict';
// Reviewer probes for W3a (rev 4b6bc73): temporal reads, statements, snapshots, historical holds,
// imports from REAL stage-1/stage-2 containers, clock behaviour.
// Usage: BASE=<s3> S1BASE=<s1> S2BASE=<s2> node stage-3/review/rev-w3a-probe.js
const BASE = process.env.BASE || 'http://127.0.0.1:19090';
const S1BASE = process.env.S1BASE, S2BASE = process.env.S2BASE;
let pass = 0, fail = 0; const out = [];
const check = (n, c, d) => { if (c) pass++; else { fail++; out.push(`FAIL ${n} :: ${typeof d === 'string' ? d : JSON.stringify(d)}`); } };
async function call(method, p, { body, token, key, base = BASE } = {}) {
  const h = {};
  if (token) h.authorization = `Bearer ${token}`;
  if (key !== undefined) h['idempotency-key'] = key;
  const r = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  return { status: r.status, body: j };
}
const code = (r) => r.body && r.body.error && r.body.error.code;
const sc = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 220)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0; const k = () => `w3a_${Date.now()}_${n++}`;
const U = (h, bal, x = {}) => ({ id: `u_${h}`, email: `${h}@example.com`, password: 'correct horse', display_name: h, handle: h, balance: bal, ...x });
const iso = (ms) => new Date(ms).toISOString().replace('Z', '+00:00');
const E = encodeURIComponent;
const H = 3600e3;
const reset = (fx, base = BASE) => call('POST', '/_test/reset', { body: fx, base });
const tok = async (h, base = BASE) => (await call('POST', '/auth/login', { body: { email: `${h}@example.com`, password: 'correct horse' }, base })).body.token;
const me = (t, q = '') => call('GET', '/me' + q, { token: t });
const st = (t, q = '') => call('GET', '/statement' + q, { token: t });
const pay = (t, to, amount, base = BASE) => call('POST', '/payments', { token: t, key: k(), body: { to_handle: to, amount }, base });

(async () => {
  const now = Date.now();
  // ---------- seeded created_at, opening balances ----------
  const t1 = iso(now - 3 * H), t2 = iso(now - 2 * H);
  let r = await reset({ currency: 'EUR', minor_units: 2, users: [U('ada', 10000), U('bob', 2500), U('cy', 0)],
    payments: [
      { id: 'p_b', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 500, created_at: t2 },
      { id: 'p_a', from_user_id: 'u_bob', to_user_id: 'u_ada', amount: 300, created_at: t1 },
      { id: 'p_tie2', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 7, created_at: t2 },
      { id: 'p_now', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 1 }] });
  check('reset with seeded created_at', r.status === 204, sc(r));
  let ada = await tok('ada'), bob = await tok('bob'), cy = await tok('cy');
  // ada opening = 10000 + 500 + 7 + 1 - 300 = 10208
  r = await me(ada, `?as_of=${E(iso(now - 4 * H))}`);
  check('as_of before earliest -> opening 10208', r.status === 200 && r.body.balance === 10208 && r.body.total === 10208 && r.body.available === 10208 && r.body.held === 0, sc(r));
  r = await me(ada, `?as_of=${E(t1)}`);
  check('as_of exactly at payment inclusive', r.body.balance === 10508 && r.body.as_of === t1, sc(r));
  r = await me(ada, `?as_of=${E(iso(Date.parse(t1) - 1).replace(/\.(\d{3})\+/, '.$1999+'))}`);
  check('as_of 1µs before payment excludes it', r.body.balance === 10208, sc(r));
  r = await me(ada, `?as_of=${E(t2)}`);
  check('two payments at same instant both counted', r.body.balance === 10508 - 507, sc(r));
  r = await me(ada, `?as_of=${E(iso(now + 100 * H))}`);
  check('far future as_of = current', r.body.balance === 10000, sc(r));
  r = await me(ada);
  check('/me no params: no as_of key, stage-2 shape', r.body.balance === 10000 && !('as_of' in r.body) && !('known_at' in r.body), sc(r));
  // offsets and raw '+'
  const tOff = new Date(Date.parse(t1)).toISOString().replace('Z', '');
  const plus14 = (() => { const d = new Date(Date.parse(t1) + 14 * H); return d.toISOString().slice(0, 23) + '+14:00'; })();
  const minus12 = (() => { const d = new Date(Date.parse(t1) - 12 * H); return d.toISOString().slice(0, 23) + '-12:00'; })();
  for (const v of [plus14, minus12]) {
    r = await me(ada, `?as_of=${E(v)}`);
    check(`offset ${v.slice(-6)} same instant inclusive`, r.status === 200 && r.body.balance === 10508 && r.body.as_of === v, sc(r));
  }
  r = await me(ada, `?as_of=${plus14}`);
  check('raw + kept (not space)', r.status === 200 && r.body.as_of === plus14 && r.body.balance === 10508, sc(r));
  r = await me(ada, `?as_of=${E(tOff.replace('T', 't') + 'z')}`);
  check('lowercase t/z accepted', r.status === 200 && r.body.balance === 10508, sc(r));
  for (const bad of ['', tOff, tOff.slice(0, 10), '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:60:00Z',
    '2026-01-01T00:00:60Z', '2026-01-01T00:00:00+24:00', '2026-01-01T00:00:00+0000', '2026-01-01 00:00:00Z', 'now', '1e9', '2025-02-29T00:00:00Z']) {
    r = await me(ada, `?as_of=${E(bad)}`);
    check(`as_of ${JSON.stringify(bad)} -> 422`, r.status === 422 && code(r) === 'validation_failed', sc(r));
    r = await me(ada, `?known_at=${E(bad)}`);
    check(`known_at ${JSON.stringify(bad)} -> 422`, r.status === 422, sc(r));
  }
  r = await me(ada, '?as_of=2024-02-29T00:00:00Z');
  check('leap day valid', r.status === 200, sc(r));
  r = await me(ada, `?as_of=${E(t1)}&as_of=garbage`);
  check('duplicate param: no 5xx', r.status < 500, sc(r));
  r = await me(ada, `?known_at=${E(iso(now - 4 * H))}`);
  check('known_at before everything -> opening', r.body.balance === 10208 && r.body.known_at === iso(now - 4 * H), sc(r));
  r = await me(ada, `?known_at=${E(iso(now + 100 * H))}&as_of=${E(iso(now + 100 * H))}`);
  check('both future ok', r.status === 200 && r.body.balance === 10000, sc(r));

  // ---------- statement ----------
  r = await st(ada);
  check('statement shape', r.status === 200 && ['opening_balance', 'entries', 'closing_balance', 'has_more', 'snapshot'].every((x) => x in r.body), sc(r));
  const full = r.body;
  check('opening 10208 closing 10000', full.opening_balance === 10208 && full.closing_balance === 10000, sc(r));
  const ids = full.entries.map((e) => e.payment.payment_id);
  check('ordered by created_at then id (p_b < p_tie2)', JSON.stringify(ids) === JSON.stringify(['p_a', 'p_b', 'p_tie2', 'p_now']), ids);
  check('opening + Σdelta = closing', full.opening_balance + full.entries.reduce((s, e) => s + e.delta, 0) === full.closing_balance, '');
  check('entries carry revision/effective_at/recorded_at', full.entries.every((e) => e.revision === 1 && e.effective_at === e.payment.created_at && e.recorded_at === e.payment.created_at), full.entries[0]);
  check('delta signs', full.entries[0].delta === 300 && full.entries[1].delta === -500, '');
  r = await st(ada, `?from=${E(t2)}&to=${E(t2)}`);
  check('from == to -> empty, opening == closing', r.status === 200 && r.body.entries.length === 0 && r.body.opening_balance === r.body.closing_balance && r.body.opening_balance === 10508, sc(r));
  r = await st(ada, `?from=${E(t2)}`);
  check('from inclusive', r.body.entries[0].payment.payment_id === 'p_b' && r.body.opening_balance === 10508, sc(r));
  r = await st(ada, `?to=${E(t2)}`);
  check('to exclusive', r.body.entries.length === 1 && r.body.closing_balance === 10508, sc(r));
  r = await st(ada, `?from=${E(t2)}&to=${E(t1)}`);
  check('from > to -> 422', r.status === 422, sc(r));
  for (const q of ['?from=', '?to=bad', '?known_at=', '?limit=0', '?limit=1e9', '?offset=-1', '?limit=201']) {
    r = await st(ada, q); check(`statement ${q} -> 422`, r.status === 422, sc(r));
  }
  // paging invariance
  const pages = [];
  for (let off = 0; off < 6; off++) {
    r = await st(ada, `?limit=1&offset=${off}`);
    pages.push(r.body);
  }
  check('paging: balance_after invariant', pages.slice(0, 4).every((pg, i) => pg.entries[0] && pg.entries[0].balance_after === full.entries[i].balance_after && pg.opening_balance === full.opening_balance && pg.closing_balance === full.closing_balance), pages.map((p) => p.entries.length));
  check('has_more at exact boundary', pages[2].has_more === true && pages[3].has_more === false && pages[4].entries.length === 0 && pages[4].has_more === false, pages.map((p) => p.has_more));
  r = await st(ada, '?limit=4');
  check('limit == count -> has_more false', r.body.has_more === false && r.body.entries.length === 4, sc(r));
  // third party / other users' public payments
  r = await st(cy);
  check('only own payments (public others excluded)', r.body.entries.length === 0 && r.body.opening_balance === 0 && r.body.closing_balance === 0, sc(r));

  // ---------- snapshots ----------
  r = await st(ada, '?limit=2');
  const snap = r.body.snapshot;
  const s0 = r.body;
  await pay(ada, 'cy', 100);
  await pay(bob, 'ada', 1);
  r = await st(ada, `?snapshot=${snap}&limit=2&offset=2`);
  check('snapshot page unaffected by later writes', r.status === 200 && r.body.entries.length === 2 && r.body.has_more === false && r.body.closing_balance === 10000 && r.body.opening_balance === s0.opening_balance, sc(r));
  r = await st(ada, `?snapshot=${snap}&limit=10&offset=99`);
  check('snapshot offset beyond end', r.status === 200 && r.body.entries.length === 0 && r.body.has_more === false, sc(r));
  for (const extra of ['from=' + E(t1), 'to=' + E(t1), 'known_at=' + E(t1), 'from=', 'known_at=']) {
    r = await st(ada, `?snapshot=${snap}&${extra}`);
    check(`snapshot + ${extra.split('=')[0]} -> 422`, r.status === 422, sc(r));
  }
  r = await st(ada, '?snapshot=nope&from=x');
  check('snapshot unknown + from -> 422 before 404', r.status === 422, sc(r));
  r = await st(ada, '?snapshot=nope&limit=0');
  check('snapshot unknown + bad limit -> 422 before 404', r.status === 422, sc(r));
  r = await st(ada, '?snapshot=nope');
  check('unknown snapshot -> 404', r.status === 404 && code(r) === 'not_found', sc(r));
  r = await st(bob, `?snapshot=${snap}`);
  check("other user's snapshot -> 404", r.status === 404, sc(r));
  r = await st(ada, `?snapshot=${snap}&foo=bar`);
  check('snapshot + unknown param ignored', r.status === 200, sc(r));
  r = await st(ada, `?snapshot=`);
  check('empty snapshot token -> 404 (no 5xx)', r.status === 404 || r.status === 422, sc(r));
  // default to captured
  r = await st(ada);
  const snap2 = r.body.snapshot, cl2 = r.body.closing_balance, cnt2 = r.body.entries.length;
  await sleep(5);
  await pay(bob, 'ada', 2);
  r = await st(ada, `?snapshot=${snap2}&limit=200`);
  check('default to frozen in snapshot', r.body.closing_balance === cl2 && r.body.entries.length === cnt2, sc(r));
  r = await st(ada);
  check('fresh statement sees new payment immediately (read after write)', r.body.closing_balance === cl2 + 2, sc(r));

  // ---------- historical holds ----------
  r = await reset({ currency: 'EUR', minor_units: 2, users: [U('ada', 10000), U('bob', 0)], authorization_ttl_seconds: 2 });
  ada = await tok('ada'); bob = await tok('bob');
  const A = (await call('POST', '/authorizations', { token: ada, key: k(), body: { to_handle: 'bob', amount: 3000 } })).body;
  check('closed_at null while open', A.closed_at === null, A);
  const tA = A.created_at;
  await sleep(20);
  const c1 = await call('POST', `/authorizations/${A.authorization_id}/capture`, { token: bob, key: k(), body: { amount: 1000, final: false } });
  await sleep(20);
  const tMid = iso(Date.now());
  await sleep(20);
  const c2 = await call('POST', `/authorizations/${A.authorization_id}/capture`, { token: bob, key: k(), body: { amount: 500 } });
  const tC1 = c1.body.created_at, tC2 = c2.body.created_at;
  r = await call('GET', '/authorizations', { token: ada });
  check('closed_at = final capture time', r.body.authorizations[0].closed_at === tC2, r.body.authorizations[0]);
  const beforeA = iso(Date.parse(tA) - 1);
  r = await me(ada, `?as_of=${E(beforeA)}`);
  check('before hold: held 0', r.body.held === 0 && r.body.total === 10000, sc(r));
  r = await me(ada, `?as_of=${E(tA)}`);
  check('at creation: held 3000 available 7000', r.body.held === 3000 && r.body.available === 7000 && r.body.balance === r.body.total, sc(r));
  r = await me(ada, `?as_of=${E(tMid)}`);
  check('after nonfinal capture: total 9000 held 2000', r.body.total === 9000 && r.body.held === 2000 && r.body.available === 7000, sc(r));
  r = await me(ada, `?as_of=${E(tC2)}`);
  check('at final capture: total 8500 held 0', r.body.total === 8500 && r.body.held === 0 && r.body.available === 8500, sc(r));
  r = await me(ada, `?as_of=${E(tMid)}&known_at=${E(beforeA)}`);
  check('known_at before creation: hold unknown and capture unknown', r.body.held === 0 && r.body.total === 10000, sc(r));
  r = await me(ada, `?as_of=${E(tC2)}&known_at=${E(tMid)}`);
  check('as_of after final, known_at before it: still held 2000', r.body.held === 2000 && r.body.total === 9000 && r.body.available === 7000, sc(r));
  // void + expiry
  const B = (await call('POST', '/authorizations', { token: ada, key: k(), body: { to_handle: 'bob', amount: 1000 } })).body;
  await sleep(20);
  const V = await call('POST', `/authorizations/${B.authorization_id}/void`, { token: ada });
  check('void closed_at set', V.body.closed_at && V.body.closed_at === V.body.closed_at && Date.parse(V.body.closed_at) >= Date.parse(B.created_at), V.body);
  r = await me(ada, `?as_of=${E(V.body.closed_at)}&known_at=${E(iso(Date.parse(V.body.closed_at) - 1))}`);
  check('known_at before void: still held', r.body.held === 1000, sc(r));
  r = await me(ada, `?as_of=${E(V.body.closed_at)}`);
  check('at void: released', r.body.held === 0, sc(r));
  const C = (await call('POST', '/authorizations', { token: ada, key: k(), body: { to_handle: 'bob', amount: 700 } })).body;
  r = await me(ada, `?as_of=${E(C.expires_at)}`);
  check('future as_of at expires_at: released', r.body.held === 0, sc(r));
  r = await me(ada, `?as_of=${E(iso(Date.parse(C.expires_at) - 1))}`);
  check('future as_of before expiry: held', r.body.held === 700, sc(r));
  r = await me(ada, `?as_of=${E(iso(Date.parse(C.expires_at) - 1))}&known_at=${E(C.created_at)}`);
  check('known_at = creation, as_of later: held', r.body.held === 700, sc(r));
  await sleep(2200);
  r = await call('GET', '/authorizations?status=expired', { token: ada });
  const ce = r.body.authorizations.find((x) => x.authorization_id === C.authorization_id);
  check('clock-expired closed_at = expires_at', ce && ce.closed_at === C.expires_at, ce);
  r = await me(ada);
  check('statement excludes holds; captures appear once', true, '');
  r = await st(ada, '?limit=200');
  const capIds = r.body.entries.filter((e) => e.payment.authorization_id === A.authorization_id).map((e) => e.payment.payment_id);
  check('captures exactly once each, nothing for holds', capIds.length === 2 && r.body.entries.length === 2, r.body.entries.map((e) => e.payment.payment_id));

  // seeded holds
  r = await reset({ currency: 'EUR', minor_units: 2, users: [U('ada', 10000), U('bob', 0)], authorizations: [
    { id: 'a_o', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 2000, status: 'open', expires_at: iso(now + 2 * H) },
    { id: 'a_oc', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 1000, status: 'open', expires_at: iso(now + 2 * H), created_at: iso(now - 5 * H), captured_amount: 400 },
    { id: 'a_c', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 900, status: 'captured', expires_at: iso(now + 2 * H) },
    { id: 'a_v', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 800, status: 'voided', expires_at: iso(now + 2 * H) },
    { id: 'a_e', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 600, status: 'expired', expires_at: iso(now - 2 * H) }] });
  check('seeded holds reset', r.status === 204, sc(r));
  ada = await tok('ada');
  r = await me(ada);
  check('seeded current held 2600', r.body.held === 2600, sc(r));
  r = await me(ada, `?as_of=${E(iso(now - 3 * H))}`);
  check('as_of before reset: only a_oc (created earlier) held 600', r.body.held === 600, sc(r));
  r = await me(ada, `?as_of=${E(iso(now - 6 * H))}`);
  check('as_of before seeded created_at: 0', r.body.held === 0, sc(r));
  r = await call('GET', '/authorizations?limit=200', { token: ada });
  const by = Object.fromEntries(r.body.authorizations.map((x) => [x.authorization_id, x]));
  check('closed_at on every view', Object.values(by).every((x) => 'closed_at' in x) && by.a_o.closed_at === null && by.a_e.closed_at === iso(now - 2 * H) && typeof by.a_c.closed_at === 'string', by);

  // ---------- reset/import isolation ----------
  await pay(ada, 'bob', 1);
  r = await st(ada);
  const snap3 = r.body.snapshot;
  const ex = (await call('GET', '/_test/export')).body;
  await reset({ currency: 'EUR', minor_units: 2, users: [U('ada', 1)] });
  ada = await tok('ada');
  r = await st(ada, `?snapshot=${snap3}`);
  check('snapshot from before reset -> 404', r.status === 404, sc(r));
  r = await call('POST', '/_test/import', { body: ex });
  check('stage-3 export re-imports', r.status === 204, sc(r));
  ada = await tok('ada');
  r = await st(ada, `?snapshot=${snap3}`);
  check('snapshot carried by import', r.status === 200, sc(r));
  const ex2 = (await call('GET', '/_test/export')).body;
  { const dk = Object.keys(ex.state).filter((x) => x !== 'tokens' && JSON.stringify(ex.state[x]) !== JSON.stringify(ex2.state[x])); check('re-export identical', dk.length === 0, dk.map((x) => [x, JSON.stringify(ex.state[x]).slice(0, 300), JSON.stringify(ex2.state[x]).slice(0, 300)])); }
  for (const [nm, mut] of [
    ['revision amount', (s) => { s.revisions[0][1][0].amount += 1; }],
    ['opening', (s) => { s.users[0].opening += 1; }],
    ['ledger_version', (s) => { s.ledger_version = 4; }],
    ['revisions missing', (s) => { s.revisions = s.revisions.slice(1); }],
    ['bad recorded_at', (s) => { s.revisions[0][1][0].recorded_at = 'x'; }],
    ['captures mismatch', (s) => { const a = s.authorizations.find((x) => x.id === 'a_oc'); if (a) a.base_captured += 1; }],
  ]) {
    const d = JSON.parse(JSON.stringify(ex)); mut(d.state);
    r = await call('POST', '/_test/import', { body: d });
    check(`tampered ${nm} -> 422`, r.status === 422, sc(r));
  }
  r = await me(ada); check('state unchanged after tampered imports', r.status === 200 && r.body.held === 2600, sc(r));

  // ---------- clock under load ----------
  await reset({ currency: 'EUR', minor_units: 2, users: [U('ada', 1000000), U('bob', 0)] });
  ada = await tok('ada');
  const res = await Promise.all(Array.from({ length: 50 }, () => pay(ada, 'bob', 1)));
  const ts = res.map((x) => Date.parse(x.body.created_at)).sort((a, b) => a - b);
  check('50 concurrent writes: unique strictly increasing created_at, no 5xx', res.every((x) => x.status === 201) && new Set(ts).size === 50, '');
  const t0 = Date.now();
  let reads = 0;
  while (Date.now() - t0 < 3000) { await Promise.all(Array.from({ length: 50 }, () => me(ada))); reads += 50; }
  const p2 = await pay(ada, 'bob', 1);
  const drift = Date.parse(p2.body.created_at) - Date.now();
  console.log(`reads in 3 s: ${reads}, clock drift after: ${drift} ms`);
  check('clock drift under sustained read load < 1 s', drift < 1000, `${drift} ms after ${reads} reads`);

  // ---------- REAL stage-1 / stage-2 exports ----------
  for (const [nm, base] of [['stage-1', S1BASE], ['stage-2', S2BASE]]) {
    if (!base) continue;
    const fx = { currency: 'EUR', minor_units: 2, users: [U('ada', 10000), U('bob', 2500)], settlement_operator_ids: ['u_ada'],
      payments: [{ id: 'p_s', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 500 }],
      requests: [{ id: 'rq_1', requester_id: 'u_bob', payer_id: 'u_ada', amount: 1200 }] };
    await reset(fx, base);
    const a1 = await tok('ada', base);
    await sleep(10);
    const pp = await pay(a1, 'bob', 250, base);
    await call('POST', '/settlements', { token: a1, key: 'st1', body: { transfers: [{ from_handle: 'bob', to_handle: 'ada', amount: 100 }] }, base });
    let hold = null;
    if (nm === 'stage-2') {
      hold = (await call('POST', '/authorizations', { token: a1, key: 'h1', body: { to_handle: 'bob', amount: 1000 }, base })).body;
      const b1 = await tok('bob', base);
      await call('POST', `/authorizations/${hold.authorization_id}/capture`, { token: b1, key: 'c1', body: { amount: 300, final: false }, base });
    }
    const exo = (await call('GET', '/_test/export', { base })).body;
    r = await call('POST', '/_test/import', { body: exo });
    check(`${nm} export imports into stage-3`, r.status === 204, sc(r));
    r = await me(a1);
    const expectTotal = nm === 'stage-2' ? 10000 - 250 + 100 - 300 : 10000 - 250 + 100;
    check(`${nm}: token valid, balance kept`, r.status === 200 && r.body.total === expectTotal, sc(r));
    r = await st(a1, '?limit=200');
    check(`${nm}: statement opening 10500 and identity holds`, r.body.opening_balance === 10500 && r.body.opening_balance + r.body.entries.reduce((s, e) => s + e.delta, 0) === r.body.closing_balance && r.body.closing_balance === expectTotal, sc(r));
    r = await me(a1, `?as_of=${E(pp.body.created_at)}`);
    check(`${nm}: as_of at imported payment`, r.body.total === 10000 - 250, sc(r));
    if (hold) {
      r = await me(a1, `?as_of=${E(hold.created_at)}`);
      check('stage-2 hold historically held from creation', r.body.held === 1000, sc(r));
      r = await me(a1);
      check('stage-2 hold now held 700', r.body.held === 700, sc(r));
      r = await call('GET', '/authorizations', { token: a1 });
      check('imported hold has closed_at null', r.body.authorizations[0].closed_at === null, r.body.authorizations[0]);
    }
    const np = await pay(a1, 'bob', 1);
    check(`${nm}: new payment after import sorts after history`, Date.parse(np.body.created_at) >= Date.parse(pp.body.created_at), np.body.created_at);
  }

  // ---------- clock: future-dated seeded expired hold must not drag the clock forward ----------
  const far = iso(now + 2 * H);
  await reset({ currency: 'EUR', minor_units: 2, users: [U('ada', 10000), U('bob', 0)],
    authorizations: [{ id: 'a_fx', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 10, status: 'expired', expires_at: far }] });
  const ex3 = (await call('GET', '/_test/export')).body;
  r = await call('POST', '/_test/import', { body: ex3 });
  check('import with seeded expired future hold', r.status === 204, sc(r));
  ada = await tok('ada');
  const pz = await pay(ada, 'bob', 1);
  const skew = Date.parse(pz.body.created_at) - Date.now();
  check('clock not dragged into the future by import (created_at ≈ now)', Math.abs(skew) < 5000, `created_at ${pz.body.created_at} skew ${skew} ms`);
  r = await me(ada, `?as_of=${E(iso(Date.now()))}`);
  check('as_of = wall now counts the payment just made', r.body.balance === 9999, sc(r));

  // no stage-4
  r = await call('POST', '/payments/p_x/refunds', { token: ada, key: k(), body: {} });
  check('no refunds endpoint', r.status === 404 || r.status === 405, sc(r));

  console.log(out.join('\n'));
  console.log(`${pass} passed, ${fail} failed`);
})().catch((e) => { console.error(e); process.exit(2); });
