'use strict';
// Reviewer probes for W4b (rev bf163ef): POST /correction-batches (H4 order, H5 shape, I22, I23),
// combined affordability/history incl. holds, settlements, concurrency, export/import.
// Usage (in-network): BASE=<s4> [S3BASE=<s3>] node stage-4/review/rev-w4b-probe.js
const BASE = process.env.BASE || 'http://127.0.0.1:19090';
const S3BASE = process.env.S3BASE;
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
const sc = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 240)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0; const k = () => `w4b_${Date.now()}_${n++}`;
const U = (h, bal) => ({ id: `u_${h}`, email: `${h}@example.com`, password: 'correct horse', display_name: h, handle: h, balance: bal });
const iso = (ms) => new Date(ms).toISOString().replace('Z', '+00:00');
const offsetOf = (isoStr, h) => { const d = new Date(Date.parse(isoStr) + h * 3600e3); return d.toISOString().slice(0, 23) + (h >= 0 ? '+' : '-') + String(Math.abs(h)).padStart(2, '0') + ':00'; };
const reset = (fx, base = BASE) => call('POST', '/_test/reset', { body: fx, base });
const tok = async (h, base = BASE) => (await call('POST', '/auth/login', { body: { email: `${h}@example.com`, password: 'correct horse' }, base })).body.token;
const me = (t, q = '') => call('GET', '/me' + q, { token: t });
const pay = async (t, to, amount, base = BASE) => (await call('POST', '/payments', { token: t, key: k(), body: { to_handle: to, amount }, base })).body;
const batch = (t, corrections, key = k(), extra = {}) => call('POST', '/correction-batches', { token: t, key, body: { corrections, ...extra } });
const I = (pid, er, amount, eff, reason = 'fix', x = {}) => ({ payment_id: pid, expected_revision: er, amount, effective_at: eff, reason, ...x });
const nowIso = () => iso(Date.now());
const FX = (x = {}) => ({ currency: 'EUR', minor_units: 2, users: [U('ada', 10000), U('bob', 5000), U('cy', 5000), U('dan', 0), U('op', 0)], settlement_operator_ids: ['u_op'], ...x });
const settle = async (t, transfers) => (await call('POST', '/settlements', { token: t, key: k(), body: { transfers } })).body;

(async () => {
  await reset(FX());
  let [ada, bob, cy, dan, op] = await Promise.all(['ada', 'bob', 'cy', 'dan', 'op'].map((h) => tok(h)));
  const P1 = await pay(ada, 'bob', 1000);
  const P2 = await pay(bob, 'cy', 500);
  const S1 = await settle(op, [{ from_handle: 'ada', to_handle: 'cy', amount: 300 }, { from_handle: 'cy', to_handle: 'bob', amount: 200 }]);
  const S2 = await settle(op, [{ from_handle: 'bob', to_handle: 'ada', amount: 100 }]);
  const [m1, m2] = S1.payments.map((x) => x.payment_id), m3 = S2.payments[0].payment_id;
  // ---- auth / shape ----
  let r = await call('POST', '/correction-batches', { key: k(), body: { corrections: [] } });
  check('no token -> 401', r.status === 401, sc(r));
  r = await batch(ada, [I(P1.payment_id, 1, 900, nowIso())]);
  check('non-operator -> 403', r.status === 403 && code(r) === 'forbidden', sc(r));
  r = await call('POST', '/correction-batches', { token: ada, body: { corrections: [] } });
  check('non-operator without key -> 403 (403 before key)', r.status === 403, sc(r));
  r = await call('POST', '/correction-batches', { token: op, body: { corrections: [I(P1.payment_id, 1, 900, nowIso())] } });
  check('operator no key -> 400', r.status === 400 && code(r) === 'missing_idempotency_key', sc(r));
  r = await call('POST', '/correction-batches', { token: op, key: k(), raw: '{oops' });
  check('unparseable -> 400', r.status === 400, sc(r));
  r = await call('POST', '/correction-batches', { token: op, key: k(), body: {} });
  check('empty {} -> 422', r.status === 422 && code(r) === 'validation_failed', sc(r));
  for (const [nm, c] of [['empty array', []], ['string', 'x'], ['33 items', Array.from({ length: 33 }, (_, i) => I('p_x' + i, 1, 1, nowIso()))],
    ['non-object item', [I(P1.payment_id, 1, 1, nowIso()), 5]], ['duplicate ids', [I(P1.payment_id, 1, 1, nowIso()), I(P1.payment_id, 1, 2, nowIso())]]]) {
    r = await batch(op, c);
    check(`shape ${nm} -> 422`, r.status === 422 && code(r) === 'validation_failed', sc(r));
  }
  r = await batch(op, [I('p_nope', 1, 1, nowIso()), I('p_nope2', 1, 1, nowIso())]);
  check('duplicate check before 404 (distinct unknown ids -> 404)', r.status === 404, sc(r));
  r = await batch(op, [{ ...I(P1.payment_id, 1, 1, nowIso()), payment_id: 7 }, { ...I(P2.payment_id, 1, 1, nowIso()), payment_id: 7 }]);
  check('non-string duplicate ids -> 422 (field error)', r.status === 422 && code(r) === 'validation_failed', sc(r));
  // ---- items in input order ----
  r = await batch(op, [I(P1.payment_id, 2, 900, nowIso()), I(P2.payment_id, 1, 1, 'bad')]);
  check('item0 stale beats item1 field error', r.status === 409 && code(r) === 'stale_revision', sc(r));
  r = await batch(op, [I(P2.payment_id, 1, 1, 'bad'), I(P1.payment_id, 2, 900, nowIso())]);
  check('item0 field error first', r.status === 422 && code(r) === 'validation_failed', sc(r));
  r = await batch(op, [I(P1.payment_id, 1, 900, iso(Date.now() + 60000))]);
  check('future effective_at -> 422', code(r) === 'validation_failed', sc(r));
  r = await batch(op, [I(P1.payment_id, 1, 900, nowIso(), '')]);
  check('empty reason -> 422', code(r) === 'validation_failed', sc(r));
  r = await batch(op, [I(P1.payment_id, 1, 900, nowIso()), I('p_nope', 1, 1, nowIso())]);
  check('unknown -> 404', r.status === 404, sc(r));
  // capture & refund immutable
  const A = (await call('POST', '/authorizations', { token: ada, key: k(), body: { to_handle: 'dan', amount: 100 } })).body;
  const cap = (await call('POST', `/authorizations/${A.authorization_id}/capture`, { token: dan, key: k(), body: {} })).body;
  const RF = (await call('POST', `/payments/${P1.payment_id}/refunds`, { token: bob, key: k(), body: { amount: 300 } })).body;
  r = await batch(op, [I(cap.payment_id, 1, 50, nowIso())]);
  check('capture -> 422 linked_payment_immutable', code(r) === 'linked_payment_immutable', sc(r));
  r = await batch(op, [I(RF.payment_id, 1, 50, nowIso())]);
  check('refund -> 422 linked_payment_immutable', code(r) === 'linked_payment_immutable', sc(r));
  r = await batch(op, [I(P1.payment_id, 1, 299, nowIso())]);
  check('below refunded -> 422 refund_exceeds_payment', code(r) === 'refund_exceeds_payment', sc(r));
  // ---- settlement completeness / instants ----
  r = await batch(op, [I(m1, 1, 0, S1.committed_at)]);
  check('incomplete settlement -> 422 incomplete_settlement', code(r) === 'incomplete_settlement', sc(r));
  r = await batch(op, [I(m1, 1, 0, S1.committed_at), I(m3, 1, 0, S2.committed_at), I(m2, 1, 0, S1.committed_at)]);
  check('two settlements, both complete (members out of order) ok?', r.status === 201, sc(r));
  const B1 = r.body;
  check('H5 shape: id, shared recorded_at, revisions in input order', B1 && B1.correction_batch_id && B1.revisions.map((x) => x.payment_id).join() === [m1, m3, m2].join()
    && B1.revisions.every((x) => x.recorded_at === B1.recorded_at && x.correction_batch_id === B1.correction_batch_id && x.revision === 2 && x.amount === 0)
    && Object.keys(B1).sort().join() === 'correction_batch_id,recorded_at,revisions'
    && Object.keys(B1.revisions[0]).sort().join() === 'amount,correction_batch_id,effective_at,payment_id,reason,recorded_at,revision', B1);
  check('recorded_at strictly after members previous', Date.parse(B1.recorded_at) > Date.parse(S2.committed_at), B1.recorded_at);
  // a new settlement for instant checks
  const S3 = await settle(op, [{ from_handle: 'ada', to_handle: 'dan', amount: 50 }, { from_handle: 'ada', to_handle: 'dan', amount: 60 }]);
  const [n1, n2] = S3.payments.map((x) => x.payment_id);
  r = await batch(op, [I(n1, 1, 40, offsetOf(S3.committed_at, 5)), I(n2, 1, 40, offsetOf(S3.committed_at, -3))]);
  check('same instant, different offsets -> 201', r.status === 201, sc(r));
  check('effective_at echoed as supplied', r.body.revisions[0].effective_at === offsetOf(S3.committed_at, 5) && r.body.revisions[1].effective_at === offsetOf(S3.committed_at, -3), r.body);
  r = await batch(op, [I(n1, 2, 30, S3.committed_at), I(n2, 2, 30, S3.committed_at.replace(/\.(\d{3})\+/, '.$1001+'))]);
  check('members 1 µs apart -> 422 validation_failed', r.status === 422 && code(r) === 'validation_failed', sc(r));
  r = await batch(op, [I(n1, 2, 30, S3.committed_at), I(n2, 1, 30, S3.committed_at)]);
  check('stale member beats instants/completeness', code(r) === 'stale_revision', sc(r));
  r = await batch(op, [I(n1, 2, 30, S3.committed_at)]);
  check('incomplete after first batch still enforced', code(r) === 'incomplete_settlement', sc(r));
  // settlement member still immutable singly
  r = await call('POST', `/payments/${n1}/corrections`, { token: ada, key: k(), body: { expected_revision: 2, amount: 1, effective_at: nowIso(), reason: 'r' } });
  check('single correction of member still linked', code(r) === 'linked_payment_immutable', sc(r));
  // revisions for a non-party operator -> 404; parties see batch id
  r = await call('GET', `/payments/${m1}/revisions`, { token: op });
  check('operator non-party reading revisions -> 404', r.status === 404, sc(r));
  r = await call('GET', `/payments/${m1}/revisions`, { token: ada });
  check('party sees batch revision with correction_batch_id', r.status === 200 && r.body.revisions[1].correction_batch_id === B1.correction_batch_id && r.body.revisions[0].correction_batch_id === null, sc(r));
  // original receipts / settlement replays unchanged
  r = await call('GET', '/activity?limit=200', { token: ada });
  const fm1 = r.body.payments.find((x) => x.payment_id === m1);
  check('activity shows original member amount & settlement id', fm1 && fm1.amount === 300 && fm1.settlement_id === S1.settlement_id, fm1);

  // ---- combined affordability & history ----
  await reset(FX({ users: [U('ada', 1000), U('bob', 0), U('cy', 0), U('dan', 0), U('op', 0)] }));
  [ada, bob, cy, dan, op] = await Promise.all(['ada', 'bob', 'cy', 'dan', 'op'].map((h) => tok(h)));
  const X1 = await pay(ada, 'bob', 600); // ada 400, bob 600
  const X2 = await pay(bob, 'ada', 300); // ada 700, bob 300
  // increase X1 by 500 alone: ada pays 500 more — ada avail 700 OK; but combined with X2 increase bob->ada +400 (bob pays 400; bob 300 avail) ...
  r = await batch(op, [I(X2.payment_id, 1, 700, X2.created_at)]);
  check('bob cannot afford +400 alone -> 409 insufficient_funds', r.status === 409 && code(r) === 'insufficient_funds', sc(r));
  r = await batch(op, [I(X1.payment_id, 1, 1000, X1.created_at), I(X2.payment_id, 1, 700, X2.created_at)]);
  check('combined net makes it affordable (bob +400 in, +400 out) -> 201', r.status === 201, sc(r));
  r = await me(ada); const ab = r.body.balance; r = await me(bob);
  check('balances after combined batch', ab === 700 && r.body.balance === 300, `${ab} ${r.body.balance}`);
  // history: moving a receipt after a spend for the receiver via batch -> historical_overdraft, nothing changes
  const revBefore = (await call('GET', `/payments/${X1.payment_id}/revisions`, { token: ada })).body.revisions.length;
  const KB = k();
  r = await batch(op, [I(X1.payment_id, 2, 1000, nowIso())], KB);
  check('receipt moved after spend -> 409 historical_overdraft', r.status === 409 && code(r) === 'historical_overdraft', sc(r));
  check('rejected batch: revisions unchanged', (await call('GET', `/payments/${X1.payment_id}/revisions`, { token: ada })).body.revisions.length === revBefore, '');
  r = await batch(op, [I(X1.payment_id, 2, 1000, X1.created_at, 'retry same key new body')], KB);
  check('rejected batch claimed no key', r.status === 201, sc(r));
  // history with holds (available)
  await reset(FX({ users: [U('ada', 1000), U('bob', 0), U('cy', 0), U('dan', 0), U('op', 0)] }));
  [ada, bob, cy, dan, op] = await Promise.all(['ada', 'bob', 'cy', 'dan', 'op'].map((h) => tok(h)));
  const Y1 = await pay(ada, 'bob', 100); await sleep(5);
  const AH = (await call('POST', '/authorizations', { token: ada, key: k(), body: { to_handle: 'cy', amount: 900 } })).body; await sleep(5);
  await call('POST', `/authorizations/${AH.authorization_id}/void`, { token: ada });
  r = await batch(op, [I(Y1.payment_id, 1, 200, Y1.created_at)]);
  check('batch breaking past AVAILABLE under a hold -> historical_overdraft', code(r) === 'historical_overdraft', sc(r));
  const BH = (await call('POST', '/authorizations', { token: bob, key: k(), body: { to_handle: 'cy', amount: 90 } })).body; await sleep(5);
  await call('POST', `/authorizations/${BH.authorization_id}/void`, { token: bob });
  r = await batch(op, [I(Y1.payment_id, 1, 50, Y1.created_at)]);
  check('receiver-side hold history checked in batch -> historical_overdraft', code(r) === 'historical_overdraft', sc(r));
  // zero-diff batch item
  r = await batch(op, [I(Y1.payment_id, 1, 100, iso(Date.parse(Y1.created_at) - 1000), 'only move')]);
  check('zero-diff item moving effective time earlier -> 201', r.status === 201, sc(r));
  r = await batch(op, [I(Y1.payment_id, 2, 100, nowIso(), 'move after hold')]);
  check('zero-diff move that breaks the receiver\'s hold history -> historical_overdraft', code(r) === 'historical_overdraft', sc(r));
  // replay
  const KR = k();
  const ok1 = await batch(op, [I(Y1.payment_id, 2, 100, Y1.created_at, 'r')], KR);
  r = await batch(op, [I(Y1.payment_id, 2, 100, Y1.created_at, 'r')], KR);
  check('replay -> 200 original', ok1.status === 201 && r.status === 200 && JSON.stringify(r.body) === JSON.stringify(ok1.body), sc(r));
  r = await batch(op, [I(Y1.payment_id, 2, 101, Y1.created_at, 'r')], KR);
  check('same key different body -> 409 reuse', code(r) === 'idempotency_key_reuse', sc(r));
  r = await batch(op, [I(Y1.payment_id, 3, 100, Y1.created_at, 'r')], KR, { unknown_field: 1 });
  check('unknown top-level field changes body -> 409 reuse', code(r) === 'idempotency_key_reuse', sc(r));
  r = await batch(op, [I(Y1.payment_id, 3, 100, Y1.created_at, 'r', { extra: true })], k(), { foo: 'bar' });
  check('unknown fields ignored -> 201', r.status === 201, sc(r));

  // ---- statements / snapshots ----
  const sn = (await call('GET', '/statement?limit=200', { token: ada })).body;
  r = await batch(op, [I(Y1.payment_id, 4, 100, Y1.created_at, 'snap')]);
  check('batch after snapshot', r.status === 201, sc(r));
  const sn2 = (await call('GET', `/statement?snapshot=${sn.snapshot}&limit=200`, { token: ada })).body;
  check('old snapshot unchanged', JSON.stringify(sn2) === JSON.stringify(sn), '');
  const fresh = (await call('GET', '/statement?limit=200', { token: ada })).body;
  const fe = fresh.entries.find((x) => x.payment.payment_id === Y1.payment_id);
  check('new statement reflects batch revision', fe && fe.revision === 5 && fe.delta === -100 && fe.recorded_at !== undefined, fe);

  // ---- concurrency: single + batch sharing an expected revision ----
  await reset(FX({ users: [U('ada', 100000), U('bob', 100000), U('cy', 0), U('dan', 0), U('op', 0)] }));
  [ada, bob, op] = await Promise.all(['ada', 'bob', 'op'].map((h) => tok(h)));
  const Z1 = await pay(ada, 'bob', 1000), Z2 = await pay(ada, 'bob', 1000);
  const rs = await Promise.all([
    ...Array.from({ length: 25 }, (_, i) => batch(op, [I(Z1.payment_id, 1, 900 + i, nowIso()), I(Z2.payment_id, 1, 900, nowIso())])),
    ...Array.from({ length: 25 }, (_, i) => call('POST', `/payments/${Z1.payment_id}/corrections`, { token: ada, key: k(), body: { expected_revision: 1, amount: 800 + i, effective_at: nowIso(), reason: 's' } }))]);
  check('concurrent single+batch sharing revision: exactly one wins, no 5xx', rs.filter((x) => x.status === 201).length === 1 && rs.every((x) => x.status < 500), rs.map((x) => x.status).join());
  const tot = (await me(ada)).body.total + (await me(bob)).body.total;
  check('Σ conserved', tot === 200000, tot);

  // ---- export/import ----
  const ex = (await call('GET', '/_test/export')).body;
  await reset(FX());
  r = await call('POST', '/_test/import', { body: ex });
  check('import with batch revisions', r.status === 204, sc(r));
  op = await tok('op'); ada = await tok('ada');
  const winner = rs.find((x) => x.status === 201);
  const lastZ1 = (await call('GET', `/payments/${Z1.payment_id}/revisions`, { token: ada })).body.revisions.slice(-1)[0];
  r = await batch(op, [I(Z1.payment_id, lastZ1.revision, lastZ1.amount, nowIso(), 'after import')]);
  check('batch after import: recorded_at > previous', r.status === 201 && Date.parse(r.body.recorded_at) > Date.parse(lastZ1.recorded_at), sc(r));
  if (winner && winner.body.correction_batch_id) {
    r = await call('GET', `/payments/${Z1.payment_id}/revisions`, { token: ada });
    check('imported batch id preserved', r.body.revisions.some((x) => x.correction_batch_id === winner.body.correction_batch_id), sc(r));
  }
  // replay after reset: key gone, payment gone -> 404
  await reset(FX());
  op = await tok('op');
  r = await batch(op, [I(Z1.payment_id, 1, 1, nowIso())]);
  check('after reset: unknown payment -> 404', r.status === 404, sc(r));
  // stage-3 export with a settlement -> stage-4 batch reversal
  if (S3BASE) {
    await reset(FX(), S3BASE);
    const o3 = await tok('op', S3BASE);
    const s3 = (await call('POST', '/settlements', { token: o3, key: 'st3', body: { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 70 }, { from_handle: 'cy', to_handle: 'bob', amount: 30 }] }, base: S3BASE })).body;
    const ex3 = (await call('GET', '/_test/export', { base: S3BASE })).body;
    r = await call('POST', '/_test/import', { body: ex3 });
    check('stage-3 export imports', r.status === 204, sc(r));
    r = await batch(o3, s3.payments.map((x) => I(x.payment_id, 1, 0, s3.committed_at, 'reverse')));
    check('reverse imported settlement in a batch', r.status === 201, sc(r));
    r = await call('POST', '/settlements', { token: o3, key: 'st3', body: { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 70 }, { from_handle: 'cy', to_handle: 'bob', amount: 30 }] } });
    check('imported settlement replay returns original body', r.status === 200 && JSON.stringify(r.body) === JSON.stringify(s3), sc(r));
  }
  console.log(out.join('\n'));
  console.log(`${pass} passed, ${fail} failed`);
})().catch((e) => { console.error(e); process.exit(2); });
