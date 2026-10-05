'use strict';
// Reviewer probes for W3b (rev 07f0d29): payment corrections, revisions, historical overdraft
// (total and available), known_at across revisions, snapshots, linked payments, imports.
// Usage (in-network recommended): BASE=<s3> [S2BASE=<s2>] node stage-3/review/rev-w3b-probe.js
const BASE = process.env.BASE || 'http://127.0.0.1:19090';
const S2BASE = process.env.S2BASE;
let pass = 0, fail = 0; const out = [];
const check = (n, c, d) => { if (c) pass++; else { fail++; out.push(`FAIL ${n} :: ${typeof d === 'string' ? d : JSON.stringify(d)}`); } };
async function call(method, p, { body, raw, token, key, base = BASE } = {}) {
  const h = {};
  if (token) h.authorization = `Bearer ${token}`;
  if (key !== undefined) h['idempotency-key'] = key;
  const r = await fetch(base + p, { method, headers: h, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  return { status: r.status, body: j };
}
const code = (r) => r.body && r.body.error && r.body.error.code;
const sc = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 220)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0; const k = () => `w3b_${Date.now()}_${n++}`;
const U = (h, bal) => ({ id: `u_${h}`, email: `${h}@example.com`, password: 'correct horse', display_name: h, handle: h, balance: bal });
const iso = (ms) => new Date(ms).toISOString().replace('Z', '+00:00');
const E = encodeURIComponent;
const H = 3600e3;
const reset = (fx, base = BASE) => call('POST', '/_test/reset', { body: fx, base });
const tok = async (h, base = BASE) => (await call('POST', '/auth/login', { body: { email: `${h}@example.com`, password: 'correct horse' }, base })).body.token;
const me = (t, q = '') => call('GET', '/me' + q, { token: t });
const st = (t, q = '') => call('GET', '/statement' + q, { token: t });
const pay = (t, to, amount, extra = {}, base = BASE) => call('POST', '/payments', { token: t, key: k(), body: { to_handle: to, amount, ...extra }, base });
const corr = (t, pid, body, key = k()) => call('POST', `/payments/${pid}/corrections`, { token: t, key, body });
const C = (er, amount, eff, reason = 'fix') => ({ expected_revision: er, amount, effective_at: eff, reason });
const nowIso = () => iso(Date.now());

(async () => {
  const now = Date.now();
  // ---------- basics, order, validation ----------
  await reset({ currency: 'EUR', minor_units: 2, users: [U('ada', 10000), U('bob', 2500), U('cy', 1000), U('op', 0)], settlement_operator_ids: ['u_op'],
    payments: [{ id: 'p_seed', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 500, created_at: iso(now - 3 * H) }] });
  let [ada, bob, cy, op] = await Promise.all(['ada', 'bob', 'cy', 'op'].map((h) => tok(h)));
  const P = (await pay(ada, 'bob', 1000, { note: 'n', visibility: 'private' })).body;
  let r = await call('POST', `/payments/${P.payment_id}/corrections`, { token: ada, body: C(1, 900, nowIso()) });
  check('no key -> 400', r.status === 400 && code(r) === 'missing_idempotency_key', sc(r));
  r = await call('POST', `/payments/${P.payment_id}/corrections`, { key: k(), body: C(1, 900, nowIso()) });
  check('no token -> 401', r.status === 401, sc(r));
  r = await corr(ada, 'p_nope', C(1, 1, nowIso()));
  check('unknown -> 404', r.status === 404, sc(r));
  r = await corr(bob, P.payment_id, C(1, 900, nowIso()));
  check('receiver -> 403', r.status === 403 && code(r) === 'forbidden', sc(r));
  r = await corr(cy, P.payment_id, C(1, 900, nowIso()));
  check('third party -> 403', r.status === 403, sc(r));
  r = await corr(cy, 'p_nope', { garbage: true });
  check('unknown + invalid body -> 404 (404 before 422)', r.status === 404, sc(r));
  r = await corr(bob, P.payment_id, { expected_revision: 'x' });
  check('non-sender + invalid body -> 403 (403 before 422)', r.status === 403, sc(r));
  const badBodies = [
    [{}, 'empty'], [C(0, 1, nowIso()), 'rev 0'], [C(-1, 1, nowIso()), 'rev -1'], [C(1.5, 1, nowIso()), 'rev 1.5'], [C('1', 1, nowIso()), 'rev string'],
    [C(true, 1, nowIso()), 'rev bool'], [C(1, -1, nowIso()), 'amount -1'], [C(1, 1000000001, nowIso()), 'amount >1e9'], [C(1, 1.5, nowIso()), 'amount 1.5'],
    [C(1, '5', nowIso()), 'amount string'], [C(1, null, nowIso()), 'amount null'], [C(1, 5, nowIso(), ''), 'reason empty'],
    [C(1, 5, nowIso(), 'x'.repeat(201)), 'reason 201'], [C(1, 5, nowIso(), 5), 'reason number'], [C(1, 5, '2026-01-01T00:00:00'), 'naive eff'],
    [C(1, 5, '2026-02-30T00:00:00Z'), 'bad date'], [C(1, 5, iso(Date.now() + 60000)), 'future eff'], [C(1, 5, 5), 'eff number'],
    [{ amount: 5, effective_at: nowIso(), reason: 'r' }, 'missing rev'], [{ expected_revision: 1, effective_at: nowIso(), reason: 'r' }, 'missing amount'],
    [{ expected_revision: 1, amount: 5, reason: 'r' }, 'missing eff'], [{ expected_revision: 1, amount: 5, effective_at: nowIso() }, 'missing reason']];
  for (const [b, nm] of badBodies) {
    r = await corr(ada, P.payment_id, b);
    check(`invalid ${nm} -> 422 validation_failed`, r.status === 422 && code(r) === 'validation_failed', sc(r));
  }
  r = await call('POST', `/payments/${P.payment_id}/corrections`, { token: ada, key: k(), raw: '{bad' });
  check('unparseable -> 400', r.status === 400, sc(r));
  r = await corr(ada, P.payment_id, C(1, 5, nowIso(), '👍'.repeat(200)));
  check('reason 200 emoji (code points) ok', r.status === 201, sc(r));
  const R2 = r.body;
  check('201 shape', R2 && R2.payment_id === P.payment_id && R2.revision === 2 && R2.amount === 5 && R2.reason === '👍'.repeat(200)
    && typeof R2.recorded_at === 'string' && Object.keys(R2).sort().join() === 'amount,effective_at,payment_id,reason,recorded_at,revision', R2);
  r = await me(ada);
  check('decrease debits receiver: ada +995', r.body.balance === 10000 - 1000 + 995, sc(r));
  r = await me(bob);
  check('bob -995', r.body.balance === 2500 + 1000 - 995, sc(r));
  // effective_at with offset echoed verbatim, equal-to-now accepted
  const effOff = (() => { const d = new Date(Date.now() - 60000 + 5.5 * H); return d.toISOString().slice(0, 23) + '+05:30'; })();
  const K3 = k();
  r = await corr(ada, P.payment_id, C(2, 700, effOff, 'r3'), K3);
  check('offset effective_at echoed exactly', r.status === 201 && r.body.effective_at === effOff && r.body.revision === 3, sc(r));
  const R3 = r.body;
  r = await corr(ada, P.payment_id, C(2, 600, nowIso()));
  check('stale revision -> 409 stale_revision', r.status === 409 && code(r) === 'stale_revision', sc(r));
  r = await corr(ada, P.payment_id, C(2, 700, effOff, 'r3'), K3);
  check('replay after newer revision state -> 200 original', r.status === 200 && JSON.stringify(r.body) === JSON.stringify(R3), sc(r));
  r = await corr(ada, P.payment_id, C(2, 701, effOff, 'r3'), K3);
  check('same key different body -> 409 reuse', r.status === 409 && code(r) === 'idempotency_key_reuse', sc(r));
  r = await corr(ada, P.payment_id, { bogus: 1 }, K3);
  check('claimed key + invalid body -> 409 reuse', r.status === 409 && code(r) === 'idempotency_key_reuse', sc(r));
  // zero-diff correction (same amount, new effective time)
  r = await corr(ada, P.payment_id, C(3, 700, iso(Date.now() - 10 * 60000), 'move'));
  check('zero-diff correction 201', r.status === 201 && r.body.revision === 4, sc(r));
  r = await me(ada);
  check('zero-diff moves no money', r.body.balance === 10000 - 700, sc(r));
  // zero amount reverses
  r = await corr(ada, P.payment_id, C(4, 0, nowIso(), 'reverse'));
  check('amount 0 reverses fully', r.status === 201, sc(r));
  r = await me(ada); check('ada back to 10000', r.body.balance === 10000, sc(r));
  // revisions endpoint
  r = await call('GET', `/payments/${P.payment_id}/revisions`, { token: bob });
  const revs = r.body && r.body.revisions;
  check('revisions for receiver: 5 in order, rev1 reason ""', r.status === 200 && revs.length === 5 && revs.map((x) => x.revision).join() === '1,2,3,4,5' && revs[0].reason === '' && revs[0].amount === 1000
    && revs[0].effective_at === P.created_at && revs[0].recorded_at === P.created_at, sc(r));
  check('recorded_at strictly increasing', revs.every((x, i) => i === 0 || Date.parse(x.recorded_at) > Date.parse(revs[i - 1].recorded_at)), revs.map((x) => x.recorded_at));
  r = await call('GET', `/payments/${P.payment_id}/revisions`, { token: cy });
  check('revisions third party (private) -> 404', r.status === 404, sc(r));
  const PUB = (await pay(ada, 'bob', 1)).body;
  r = await call('GET', `/payments/${PUB.payment_id}/revisions`, { token: cy });
  check('revisions third party (public) -> 404', r.status === 404, sc(r));
  r = await call('GET', `/payments/${PUB.payment_id}/revisions`);
  check('revisions no token -> 401', r.status === 401, sc(r));
  r = await call('GET', '/payments/p_nope/revisions', { token: ada });
  check('revisions unknown -> 404', r.status === 404, sc(r));
  // activity and original receipt unchanged
  r = await call('GET', '/activity?limit=200', { token: ada });
  const feedP = r.body.payments.find((x) => x.payment_id === P.payment_id);
  check('activity shows original payment, no new feed items', feedP && feedP.amount === 1000 && JSON.stringify(feedP) === JSON.stringify(P) && r.body.payments.length === 3, r.body.payments.length);
  // statement with multiple revisions and known_at between them
  r = await st(ada, `?known_at=${E(iso(Date.parse(R3.recorded_at) - 1))}&limit=200`);
  let e = r.body.entries.find((x) => x.payment.payment_id === P.payment_id);
  check('known_at before rev3 selects rev2 (amount 5)', e && e.revision === 2 && e.payment.amount === 5 && e.delta === -5 && e.recorded_at === R2.recorded_at, e);
  r = await st(ada, `?known_at=${E(R3.recorded_at)}&limit=200`);
  e = r.body.entries.find((x) => x.payment.payment_id === P.payment_id);
  check('known_at exactly rev3 recorded_at selects rev3 at its effective_at', e && e.revision === 3 && e.effective_at === effOff && e.payment.amount === 700, e);
  r = await st(ada, '?limit=200');
  e = r.body.entries.find((x) => x.payment.payment_id === P.payment_id);
  check('latest: zero entry with zero delta, counted once', e && e.revision === 5 && e.delta === 0 && r.body.entries.filter((x) => x.payment.payment_id === P.payment_id).length === 1, e);
  check('statement identity', r.body.opening_balance + r.body.entries.reduce((s, x) => s + x.delta, 0) === r.body.closing_balance && r.body.closing_balance === 9999, sc(r));
  r = await me(ada, `?known_at=${E(iso(Date.parse(P.created_at) - 1))}`);
  check('known_at before payment: contributes nothing', r.body.balance === 10000, sc(r));
  // Σ conservation in historical views
  for (const K of [R2.recorded_at, R3.recorded_at, nowIso()]) {
    for (const T of [iso(now - 4 * H), iso(now - 2 * H), R2.recorded_at, nowIso()]) {
      const tot = (await Promise.all([ada, bob, cy, op].map((t) => me(t, `?as_of=${E(T)}&known_at=${E(K)}`)))).reduce((s, x) => s + x.body.total, 0);
      if (tot !== 13500) { check(`Σ total at T=${T} K=${K}`, false, tot); }
    }
  }
  check('Σ totals conserved across historical views (checked 12)', true, '');
  // snapshot immutability across correction
  const P2 = (await pay(ada, 'bob', 300)).body;
  r = await st(ada, '?limit=1');
  const snapTok = r.body.snapshot, closing0 = r.body.closing_balance;
  const full0 = (await st(ada, `?snapshot=${snapTok}&limit=200`)).body;
  await corr(ada, P2.payment_id, C(1, 100, iso(now - 4 * H), 'earlier'));
  r = await st(ada, `?snapshot=${snapTok}&limit=200`);
  check('snapshot unchanged after correction', JSON.stringify(r.body) === JSON.stringify(full0) && r.body.closing_balance === closing0, sc(r));
  r = await st(ada, `?from=${E(iso(now - 5 * H))}&to=${E(iso(now - 3.5 * H))}`);
  check('correction moved payment into an earlier window', r.body.entries.length === 1 && r.body.entries[0].payment.payment_id === P2.payment_id && r.body.entries[0].delta === -100, sc(r));
  // seeded payment correction
  r = await corr(ada, 'p_seed', C(1, 400, iso(now - 3 * H), 'seed fix'));
  check('seeded payment correctable', r.status === 201, sc(r));
  r = await st(ada, `?to=${E(iso(now - 2 * H))}`);
  check('opening unchanged by corrections', r.body.opening_balance === 10500, sc(r));
  // linked payments
  const S = (await call('POST', '/settlements', { token: op, key: k(), body: { transfers: [{ from_handle: 'ada', to_handle: 'cy', amount: 10 }] } })).body;
  r = await corr(ada, S.payments[0].payment_id, C(1, 5, nowIso()));
  check('settlement member -> 422 linked_payment_immutable', r.status === 422 && code(r) === 'linked_payment_immutable', sc(r));
  r = await corr(ada, S.payments[0].payment_id, C(1, 5, 'bad'));
  check('member + invalid field -> 422 validation_failed (fields first)', r.status === 422 && code(r) === 'validation_failed', sc(r));
  const A = (await call('POST', '/authorizations', { token: ada, key: k(), body: { to_handle: 'bob', amount: 50 } })).body;
  const cap = (await call('POST', `/authorizations/${A.authorization_id}/capture`, { token: bob, key: k(), body: {} })).body;
  r = await corr(ada, cap.payment_id, C(1, 5, nowIso()));
  check('capture -> 422 linked_payment_immutable', r.status === 422 && code(r) === 'linked_payment_immutable', sc(r));
  r = await corr(ada, cap.payment_id, C(9, 5, nowIso()));
  check('linked beats stale', code(r) === 'linked_payment_immutable', sc(r));

  // ---------- insufficient funds (available) vs historical overdraft ----------
  await reset({ currency: 'EUR', minor_units: 2, users: [U('ada', 1000), U('bob', 0), U('cy', 0)] });
  [ada, bob, cy] = await Promise.all(['ada', 'bob', 'cy'].map((h) => tok(h)));
  const Q = (await pay(ada, 'bob', 500)).body;   // ada 500, bob 500
  await call('POST', '/authorizations', { token: ada, key: k(), body: { to_handle: 'cy', amount: 400 } }); // ada available 100
  r = await corr(ada, Q.payment_id, C(1, 650, Q.created_at));
  check('increase > sender available (held) -> 409 insufficient_funds', r.status === 409 && code(r) === 'insufficient_funds', sc(r));
  r = await corr(ada, Q.payment_id, C(1, 600, Q.created_at));
  check('increase = sender available -> 201', r.status === 201, sc(r));
  await call('POST', '/authorizations', { token: bob, key: k(), body: { to_handle: 'cy', amount: 450 } }); // bob 400 total? bob = 600, held 450 -> avail 150
  r = await corr(ada, Q.payment_id, C(2, 400, Q.created_at));
  check('decrease > receiver available -> 409 insufficient_funds', r.status === 409 && code(r) === 'insufficient_funds', sc(r));
  r = await corr(ada, Q.payment_id, C(2, 450, Q.created_at));
  check('decrease = receiver available -> 201', r.status === 201, sc(r));
  r = await corr(ada, Q.payment_id, C(2, 450, Q.created_at));
  check('stale beats funds', code(r) === 'stale_revision', sc(r));

  // historical overdraft on total: receiver spent the money; moving receipt later breaks history
  await reset({ currency: 'EUR', minor_units: 2, users: [U('ada', 1000), U('bob', 0), U('cy', 0)] });
  [ada, bob, cy] = await Promise.all(['ada', 'bob', 'cy'].map((h) => tok(h)));
  const X = (await pay(ada, 'bob', 500)).body; await sleep(5);
  const Y = (await pay(bob, 'cy', 500)).body; await sleep(5);
  const tLater = nowIso();
  const before = await Promise.all([ada, bob, cy].map((t) => me(t)));
  const revBefore = (await call('GET', `/payments/${X.payment_id}/revisions`, { token: ada })).body;
  const stBefore = (await st(bob, '?limit=200')).body;
  r = await corr(ada, X.payment_id, C(1, 500, tLater, 'late'));
  check('moving receipt after spend -> 409 historical_overdraft', r.status === 409 && code(r) === 'historical_overdraft', sc(r));
  const after = await Promise.all([ada, bob, cy].map((t) => me(t)));
  check('failure preserves balances', JSON.stringify(after.map((x) => x.body.balance)) === JSON.stringify(before.map((x) => x.body.balance)), '');
  check('failure preserves revisions', JSON.stringify((await call('GET', `/payments/${X.payment_id}/revisions`, { token: ada })).body) === JSON.stringify(revBefore), '');
  const stAfter = (await st(bob, '?limit=200')).body;
  check('failure preserves statements', JSON.stringify(stAfter.entries) === JSON.stringify(stBefore.entries), '');
  r = await corr(ada, X.payment_id, C(1, 500, Y.created_at, 'same instant'));
  check('receipt moved to the exact spend instant -> combined boundary ok', r.status === 201, sc(r));
  // sender side: moving a payment earlier than sender had funds
  await reset({ currency: 'EUR', minor_units: 2, users: [U('ada', 0), U('bob', 1000), U('cy', 0)] });
  [ada, bob, cy] = await Promise.all(['ada', 'bob', 'cy'].map((h) => tok(h)));
  const tEarly = nowIso(); await sleep(5);
  await pay(bob, 'ada', 600); await sleep(5);
  const Z = (await pay(ada, 'cy', 500)).body;
  r = await corr(ada, Z.payment_id, C(1, 500, tEarly, 'too early'));
  check('sending before funds arrived -> 409 historical_overdraft', r.status === 409 && code(r) === 'historical_overdraft', sc(r));
  r = await corr(ada, Z.payment_id, C(1, 500, iso(Date.now() - 4 * H), 'before account'));
  check('effective before any activity -> historical_overdraft', r.status === 409 && code(r) === 'historical_overdraft', sc(r));
  r = await corr(ada, Z.payment_id, C(1, 600, nowIso(), 'increase ok'));
  check('increase within funds ok', r.status === 201, sc(r));
  // available-only historical overdraft: hold exists; total stays >= 0 but available < 0
  await reset({ currency: 'EUR', minor_units: 2, users: [U('ada', 1000), U('bob', 0), U('cy', 0)] });
  [ada, bob, cy] = await Promise.all(['ada', 'bob', 'cy'].map((h) => tok(h)));
  const W = (await pay(ada, 'bob', 100)).body; await sleep(5);
  const AH = (await call('POST', '/authorizations', { token: ada, key: k(), body: { to_handle: 'cy', amount: 900 } })).body; await sleep(5);
  await call('POST', `/authorizations/${AH.authorization_id}/void`, { token: ada }); // ada avail 900 now
  r = await corr(ada, W.payment_id, C(1, 200, W.created_at, 'raise'));
  check('increase breaking past AVAILABLE (during hold) -> historical_overdraft', r.status === 409 && code(r) === 'historical_overdraft', sc(r));
  r = await corr(ada, W.payment_id, C(1, 200, nowIso(), 'raise after void'));
  check('same increase effective after void -> 201', r.status === 201, sc(r));
  // receiver hold events matter for a decrease
  await reset({ currency: 'EUR', minor_units: 2, users: [U('ada', 1000), U('bob', 0), U('cy', 0)] });
  [ada, bob, cy] = await Promise.all(['ada', 'bob', 'cy'].map((h) => tok(h)));
  const V = (await pay(ada, 'bob', 500)).body; await sleep(5);
  const BH = (await call('POST', '/authorizations', { token: bob, key: k(), body: { to_handle: 'cy', amount: 450 } })).body; await sleep(5);
  await call('POST', `/authorizations/${BH.authorization_id}/void`, { token: bob });
  r = await corr(ada, V.payment_id, C(1, 100, V.created_at, 'cut'));
  check('decrease breaking receiver past available (their hold) -> historical_overdraft', r.status === 409 && code(r) === 'historical_overdraft', sc(r));
  // incoming holds are irrelevant
  const IH = (await call('POST', '/authorizations', { token: ada, key: k(), body: { to_handle: 'bob', amount: 400 } })).body;
  r = await corr(ada, V.payment_id, C(1, 450, V.created_at, 'small cut'));
  check('receiver incoming hold irrelevant -> 201', r.status === 201, sc(r));

  // ---------- concurrency ----------
  await reset({ currency: 'EUR', minor_units: 2, users: [U('ada', 100000), U('bob', 100000)] });
  [ada, bob] = await Promise.all(['ada', 'bob'].map((h) => tok(h)));
  const CC = (await pay(ada, 'bob', 1000)).body;
  const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => corr(ada, CC.payment_id, C(1, 900 + i, nowIso(), 'c' + i))));
  check('50 concurrent same expected_revision -> exactly one 201, rest stale', rs.filter((x) => x.status === 201).length === 1 && rs.filter((x) => code(x) === 'stale_revision').length === 49, rs.map((x) => x.status).join());
  const mixed = await Promise.all([
    ...Array.from({ length: 20 }, (_, i) => corr(ada, CC.payment_id, C(2, 800 + i, nowIso(), 'm'))),
    ...Array.from({ length: 20 }, () => pay(ada, 'bob', 1)),
    ...Array.from({ length: 10 }, () => pay(bob, 'ada', 1))]);
  check('mixed concurrent: no 5xx', mixed.every((x) => x.status < 500), mixed.map((x) => x.status).join());
  const tt = (await me(ada)).body.total + (await me(bob)).body.total;
  check('Σ conserved after concurrent mix', tt === 200000, tt);

  // ---------- export/import of corrected state ----------
  const ex = (await call('GET', '/_test/export')).body;
  const R1keyBody = C(1, 950, nowIso(), 'x');
  await reset({ currency: 'EUR', minor_units: 2, users: [U('zz', 1)] });
  r = await call('POST', '/_test/import', { body: ex });
  check('import corrected state', r.status === 204, sc(r));
  r = await call('GET', `/payments/${CC.payment_id}/revisions`, { token: ada });
  check('revisions preserved', r.status === 200 && r.body.revisions.length >= 2, sc(r));
  r = await call('POST', `/payments/${CC.payment_id}/corrections`, { token: ada, key: 'nokey', body: R1keyBody });
  check('stale after import', code(r) === 'stale_revision', sc(r));
  const last = (await call('GET', `/payments/${CC.payment_id}/revisions`, { token: ada })).body.revisions.slice(-1)[0];
  r = await corr(ada, CC.payment_id, C(last.revision, last.amount + 1, nowIso(), 'post import'));
  check('correction after import: recorded_at > previous', r.status === 201 && Date.parse(r.body.recorded_at) > Date.parse(last.recorded_at), sc(r));
  const tam = JSON.parse(JSON.stringify(ex));
  const row = tam.state.revisions.find((x) => x[0] === CC.payment_id);
  row[1][row[1].length - 1].amount += 1;
  r = await call('POST', '/_test/import', { body: tam });
  check('tampered latest revision amount -> 422 (ledger identity)', r.status === 422, sc(r));
  const tam2 = JSON.parse(JSON.stringify(ex));
  const row2 = tam2.state.revisions.find((x) => x[0] === CC.payment_id);
  row2[1][1].recorded_at = row2[1][0].recorded_at;
  r = await call('POST', '/_test/import', { body: tam2 });
  check('tampered non-increasing recorded_at -> 422', r.status === 422, sc(r));
  // replay of a correction after reset: key no longer claimed
  await reset({ currency: 'EUR', minor_units: 2, users: [U('ada', 1000), U('bob', 0)] });
  ada = await tok('ada');
  r = await corr(ada, CC.payment_id, C(1, 1, nowIso()));
  check('after reset old payment unknown -> 404', r.status === 404, sc(r));

  // ---------- imported stage-2 history ----------
  if (S2BASE) {
    await reset({ currency: 'EUR', minor_units: 2, users: [U('ada', 1000), U('bob', 0)] }, S2BASE);
    const a2 = await tok('ada', S2BASE);
    const p2 = (await pay(a2, 'bob', 300, {}, S2BASE)).body;
    const ex2 = (await call('GET', '/_test/export', { base: S2BASE })).body;
    r = await call('POST', '/_test/import', { body: ex2 });
    check('stage-2 import', r.status === 204, sc(r));
    r = await corr(a2, p2.payment_id, C(1, 200, nowIso(), 'post-upgrade'));
    check('correct an imported stage-2 payment', r.status === 201 && r.body.revision === 2, sc(r));
    r = await me(a2); check('balance after imported correction', r.body.balance === 800, sc(r));
  }
  // no stage-4
  r = await call('POST', '/payments/x/refunds', { token: ada, key: k(), body: {} });
  check('no refunds endpoint', r.status === 404 || r.status === 405, sc(r));
  r = await call('POST', '/corrections', { token: ada, key: k(), body: {} });
  check('no correction batches', r.status === 404 || r.status === 405, sc(r));

  console.log(out.join('\n'));
  console.log(`${pass} passed, ${fail} failed`);
})().catch((e) => { console.error(e); process.exit(2); });
