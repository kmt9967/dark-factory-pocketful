'use strict';
// Reviewer probes for W4a (rev e66eb82): refunds, corrections with refunds, I20/I21/I24.
// Usage (in-network): BASE=<s4> [S3BASE=<s3>] node stage-4/review/rev-w4a-probe.js
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
const sc = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 220)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0; const k = () => `w4a_${Date.now()}_${n++}`;
const U = (h, bal) => ({ id: `u_${h}`, email: `${h}@example.com`, password: 'correct horse', display_name: h, handle: h, balance: bal });
const iso = (ms) => new Date(ms).toISOString().replace('Z', '+00:00');
const E = encodeURIComponent;
const reset = (fx, base = BASE) => call('POST', '/_test/reset', { body: fx, base });
const tok = async (h, base = BASE) => (await call('POST', '/auth/login', { body: { email: `${h}@example.com`, password: 'correct horse' }, base })).body.token;
const me = (t, q = '') => call('GET', '/me' + q, { token: t });
const pay = async (t, to, amount, extra = {}, base = BASE) => (await call('POST', '/payments', { token: t, key: k(), body: { to_handle: to, amount, ...extra }, base })).body;
const refund = (t, pid, body, key = k()) => call('POST', `/payments/${pid}/refunds`, { token: t, key, body });
const corr = (t, pid, body, key = k()) => call('POST', `/payments/${pid}/corrections`, { token: t, key, body });
const C = (er, amount, eff, reason = 'fix') => ({ expected_revision: er, amount, effective_at: eff, reason });
const nowIso = () => iso(Date.now());
const FX = (x = {}) => ({ currency: 'EUR', minor_units: 2, users: [U('ada', 10000), U('bob', 1000), U('cy', 1000), U('op', 0)], settlement_operator_ids: ['u_op'], ...x });

(async () => {
  await reset(FX());
  let [ada, bob, cy, op] = await Promise.all(['ada', 'bob', 'cy', 'op'].map((h) => tok(h)));
  const P = await pay(ada, 'bob', 1000, { note: 'dinner 🍝', visibility: 'private' });
  check('payments carry refund_of: null', P.refund_of === null, P);
  // ---- H1 order ----
  let r = await call('POST', `/payments/${P.payment_id}/refunds`, { token: bob, body: { amount: 1 } });
  check('no key -> 400', r.status === 400 && code(r) === 'missing_idempotency_key', sc(r));
  r = await call('POST', `/payments/${P.payment_id}/refunds`, { key: k(), body: { amount: 1 } });
  check('no token -> 401', r.status === 401, sc(r));
  r = await call('POST', `/payments/${P.payment_id}/refunds`, { token: bob, key: k(), raw: '[1]' });
  check('non-object body -> 400', r.status === 400, sc(r));
  r = await refund(bob, 'p_nope', { amount: 'x' });
  check('unknown + bad amount -> 404', r.status === 404, sc(r));
  r = await refund(ada, P.payment_id, { amount: 'x' });
  check('sender + bad amount -> 403', r.status === 403 && code(r) === 'forbidden', sc(r));
  r = await refund(cy, P.payment_id, { amount: 1 });
  check('third party -> 403', r.status === 403, sc(r));
  for (const a of [0, -1, 1.5, '5', true, null, 1000000001]) {
    r = await refund(bob, P.payment_id, { amount: a });
    check(`amount ${JSON.stringify(a)} -> 422 validation_failed`, r.status === 422 && code(r) === 'validation_failed', sc(r));
  }
  r = await refund(bob, P.payment_id, {});
  check('missing amount -> 422', r.status === 422 && code(r) === 'validation_failed', sc(r));
  r = await refund(bob, P.payment_id, { amount: 1001 });
  check('above amount -> 422 refund_exceeds_payment', r.status === 422 && code(r) === 'refund_exceeds_payment', sc(r));
  // receiver short on available: exceeds beats funds; funds 409 otherwise
  await call('POST', '/authorizations', { token: bob, key: k(), body: { to_handle: 'cy', amount: 1900 } }); // bob total 2000, avail 100
  r = await refund(bob, P.payment_id, { amount: 2000 });
  check('exceeds before insufficient', code(r) === 'refund_exceeds_payment', sc(r));
  r = await refund(bob, P.payment_id, { amount: 101 });
  check('held funds block refund -> 409 insufficient_funds', r.status === 409 && code(r) === 'insufficient_funds', sc(r));
  const KR = k();
  r = await refund(bob, P.payment_id, { amount: 100 }, KR);
  check('refund within available 201', r.status === 201, sc(r));
  const R1 = r.body;
  check('refund shape: reversed parties, links, note/visibility copied', R1.from_user_id === 'u_bob' && R1.to_user_id === 'u_ada' && R1.refund_of === P.payment_id
    && R1.request_id === null && R1.authorization_id === null && R1.settlement_id === null && R1.note === 'dinner 🍝' && R1.visibility === 'private' && R1.amount === 100
    && Date.parse(R1.created_at) >= Date.parse(P.created_at), R1);
  r = await refund(bob, P.payment_id, { amount: 100.0 }, KR);
  check('replay 200 same body', r.status === 200 && JSON.stringify(r.body) === JSON.stringify(R1), sc(r));
  r = await refund(bob, P.payment_id, { amount: 99 }, KR);
  check('same key different body -> 409 reuse', r.status === 409 && code(r) === 'idempotency_key_reuse', sc(r));
  r = await refund(bob, P.payment_id, { amount: 'bad' }, KR);
  check('claimed key + invalid body -> 409 reuse', r.status === 409 && code(r) === 'idempotency_key_reuse', sc(r));
  // refund of refund
  r = await refund(ada, R1.payment_id, { amount: 1 });
  check('refund of refund by its receiver -> 422 invalid_refund_target', r.status === 422 && code(r) === 'invalid_refund_target', sc(r));
  r = await refund(bob, R1.payment_id, { amount: 1 });
  check('refund of refund by its sender -> 403', r.status === 403, sc(r));
  r = await refund(ada, R1.payment_id, { amount: 0 });
  check('refund-of-refund + bad amount -> 422 validation_failed (amount first)', code(r) === 'validation_failed', sc(r));
  // feed / statement / history
  r = await call('GET', '/activity?limit=200', { token: cy });
  check('private refund hidden from third party', !r.body.payments.some((x) => x.payment_id === R1.payment_id), '');
  r = await call('GET', '/activity?limit=200', { token: ada });
  check('refund in feed for parties with refund_of', r.body.payments.some((x) => x.payment_id === R1.payment_id && x.refund_of === P.payment_id), '');
  r = await call('GET', '/statement?limit=200', { token: ada });
  const e = r.body.entries.find((x) => x.payment.payment_id === R1.payment_id);
  check('refund in statement with +delta for original sender', e && e.delta === 100 && e.payment.refund_of === P.payment_id, e);
  check('statement identity', r.body.opening_balance + r.body.entries.reduce((s, x) => s + x.delta, 0) === r.body.closing_balance, '');
  r = await me(ada, `?as_of=${E(iso(Date.parse(R1.created_at) - 1))}`);
  check('as_of before refund excludes it', r.body.balance === 9000, sc(r));
  r = await me(ada, `?as_of=${E(R1.created_at)}`);
  check('as_of at refund includes it', r.body.balance === 9100, sc(r));
  r = await call('GET', `/payments/${R1.payment_id}/revisions`, { token: ada });
  check('refund has revision 1 with correction_batch_id null', r.status === 200 && r.body.revisions.length === 1 && r.body.revisions[0].correction_batch_id === null, sc(r));
  // cumulative cap
  await call('POST', '/authorizations', { token: cy, key: k(), body: { to_handle: 'ada', amount: 1 } });
  r = await call('GET', '/authorizations?direction=outgoing', { token: bob });
  await call('POST', `/authorizations/${r.body.authorizations[0].authorization_id}/void`, { token: bob }); // bob avail back
  r = await refund(bob, P.payment_id, { amount: 900 });
  check('cumulative up to amount ok (100+900)', r.status === 201, sc(r));
  r = await refund(bob, P.payment_id, { amount: 1 });
  check('cumulative over -> 422 refund_exceeds_payment', code(r) === 'refund_exceeds_payment', sc(r));

  // ---- corrections with refunds ----
  await reset(FX());
  [ada, bob, cy, op] = await Promise.all(['ada', 'bob', 'cy', 'op'].map((h) => tok(h)));
  const Q = await pay(ada, 'bob', 1000);
  const RQ = (await refund(bob, Q.payment_id, { amount: 400 })).body;
  r = await corr(ada, Q.payment_id, C(1, 399, Q.created_at));
  check('correction below refunded -> 422 refund_exceeds_payment', r.status === 422 && code(r) === 'refund_exceeds_payment', sc(r));
  r = await corr(ada, Q.payment_id, C(2, 399, Q.created_at));
  check('stale beats refund_exceeds', code(r) === 'stale_revision', sc(r));
  r = await corr(ada, Q.payment_id, C(1, 399, 'bad'));
  check('field 422 beats refund_exceeds', code(r) === 'validation_failed', sc(r));
  r = await corr(ada, Q.payment_id, C(1, 400, Q.created_at, 'to refunded'));
  check('correction equal to refunded ok', r.status === 201 && r.body.correction_batch_id === null, sc(r));
  r = await refund(bob, Q.payment_id, { amount: 1 });
  check('after correction down, refund limit uses corrected amount', code(r) === 'refund_exceeds_payment', sc(r));
  r = await corr(ada, Q.payment_id, C(2, 1500, Q.created_at, 'up'));
  check('increase ok', r.status === 201, sc(r));
  r = await refund(bob, Q.payment_id, { amount: 1100 });
  check('after increase, refund up to new amount ok', r.status === 201, sc(r));
  r = await refund(bob, Q.payment_id, { amount: 1 });
  check('cap at corrected 1500', code(r) === 'refund_exceeds_payment', sc(r));
  r = await corr(ada, RQ.payment_id, C(1, 1, nowIso()));
  check('correct a refund -> 403 for non-sender of refund', r.status === 403, sc(r));
  r = await corr(bob, RQ.payment_id, C(1, 1, nowIso()));
  check('correct a refund by its sender -> 422 linked_payment_immutable', r.status === 422 && code(r) === 'linked_payment_immutable', sc(r));
  // moving the original later than its refund breaks the receiver's history
  await reset(FX({ users: [U('ada', 10000), U('bob', 0), U('cy', 0)], settlement_operator_ids: [] }));
  [ada, bob] = await Promise.all(['ada', 'bob'].map((h) => tok(h)));
  const M = await pay(ada, 'bob', 1000); await sleep(5);
  const RM = (await refund(bob, M.payment_id, { amount: 1000 })).body; await sleep(5);
  const later = nowIso();
  r = await corr(ada, M.payment_id, C(1, 1000, later, 'moved after refund'));
  check('original moved after its refund -> historical_overdraft', r.status === 409 && code(r) === 'historical_overdraft', sc(r));
  r = await corr(ada, M.payment_id, C(1, 1000, iso(Date.parse(M.created_at) - 60000), 'moved earlier'));
  check('original moved earlier with refund present -> 201', r.status === 201, sc(r));
  r = await me(bob); check('bob total 0 after refund', r.body.balance === 0, sc(r));
  r = await corr(ada, M.payment_id, C(2, 1200, iso(Date.parse(M.created_at) - 60000), 'raise'));
  { const rr = await corr(ada, M.payment_id, C(3, 1300, nowIso(), 'raise+move after refund')); check('raise that moves receipt after the refund -> historical_overdraft', code(rr) === 'historical_overdraft', sc(rr)); }
  check('raise after full refund ok (ada pays 200 more)', r.status === 201, sc(r));
  r = await refund(bob, M.payment_id, { amount: 200 });
  check('further refund allowed up to new corrected amount', r.status === 201, sc(r));

  // ---- capture / request / settlement member refunds ----
  await reset(FX());
  [ada, bob, cy, op] = await Promise.all(['ada', 'bob', 'cy', 'op'].map((h) => tok(h)));
  const A = (await call('POST', '/authorizations', { token: ada, key: k(), body: { to_handle: 'bob', amount: 3000, note: 'dep', visibility: 'public' } })).body;
  const cap = (await call('POST', `/authorizations/${A.authorization_id}/capture`, { token: bob, key: k(), body: { amount: 1000 } })).body;
  r = await refund(bob, cap.payment_id, { amount: 600 });
  check('refund of capture 201 with authorization_id null', r.status === 201 && r.body.authorization_id === null && r.body.refund_of === cap.payment_id && r.body.note === 'dep', sc(r));
  r = await call('GET', '/authorizations', { token: ada });
  const av = r.body.authorizations[0];
  check('authorization unchanged (captured, remaining 0, released)', av.status === 'captured' && av.captured_amount === 1000 && av.remaining_amount === 0, av);
  r = await me(ada);
  check('ada: no hold restored', r.body.held === 0 && r.body.total === 10000 - 1000 + 600, sc(r));
  r = await corr(ada, cap.payment_id, C(1, 1, nowIso()));
  check('capture still immutable', code(r) === 'linked_payment_immutable', sc(r));
  const rq = (await call('POST', '/requests', { token: bob, key: k(), body: { payer_handle: 'ada', amount: 500 } })).body;
  const rp = (await call('POST', `/requests/${rq.request_id}/pay`, { token: ada, key: k(), body: { visibility: 'private' } })).body;
  r = await refund(bob, rp.payment_id, { amount: 500 });
  check('refund of request payment: request_id null, private copied', r.status === 201 && r.body.request_id === null && r.body.visibility === 'private', sc(r));
  r = await call('GET', '/requests', { token: ada });
  check('request stays paid', r.body.requests.find((x) => x.request_id === rq.request_id).status === 'paid', '');
  r = await call('POST', `/requests/${rq.request_id}/pay`, { token: ada, key: k(), body: {} });
  check('request not payable again', code(r) === 'request_not_pending', sc(r));
  const S = (await call('POST', '/settlements', { token: op, key: k(), body: { transfers: [{ from_handle: 'ada', to_handle: 'cy', amount: 300 }, { from_handle: 'ada', to_handle: 'bob', amount: 200 }] } })).body;
  r = await refund(cy, S.payments[0].payment_id, { amount: 300 });
  check('refund of settlement member: settlement_id null', r.status === 201 && r.body.settlement_id === null, sc(r));
  r = await call('GET', '/activity?limit=200', { token: ada });
  const mem = r.body.payments.find((x) => x.payment_id === S.payments[0].payment_id);
  check('member keeps settlement_id', mem && mem.settlement_id === S.settlement_id, mem);
  r = await corr(ada, S.payments[0].payment_id, C(1, 300, nowIso()));
  check('member single correction still linked', code(r) === 'linked_payment_immutable', sc(r));

  // ---- concurrency: refunds + corrections on one payment never break I20 ----
  await reset(FX({ users: [U('ada', 100000), U('bob', 100000), U('cy', 0)], settlement_operator_ids: [] }));
  [ada, bob] = await Promise.all(['ada', 'bob'].map((h) => tok(h)));
  const Z = await pay(ada, 'bob', 1000);
  const mix = await Promise.all([
    ...Array.from({ length: 40 }, () => refund(bob, Z.payment_id, { amount: 30 })),
    ...Array.from({ length: 10 }, (_, i) => corr(ada, Z.payment_id, C(1, 500 + i * 50, Z.created_at, 'c')))]);
  check('mixed refunds+corrections: no 5xx', mix.every((x) => x.status < 500), mix.map((x) => x.status).join());
  const revs = (await call('GET', `/payments/${Z.payment_id}/revisions`, { token: ada })).body.revisions;
  const latest = revs[revs.length - 1].amount;
  const refundedSum = mix.filter((x, i) => i < 40 && x.status === 201).length * 30;
  check('I20 holds after concurrent mix', refundedSum <= latest, `${refundedSum} > ${latest}`);
  const tot = (await me(ada)).body.total + (await me(bob)).body.total;
  check('Σ conserved', tot === 200000, tot);

  // ---- export/import ----
  {
    const rv = (await call('GET', `/payments/${Z.payment_id}/revisions`, { token: ada })).body.revisions;
    const lt = rv[rv.length - 1];
    const cr = await corr(ada, Z.payment_id, C(lt.revision, lt.amount, Z.created_at, 'ensure rev>=2'));
    check('setup: extra revision on Z', cr.status === 201, sc(cr));
  }
  const ex = (await call('GET', '/_test/export')).body;
  await reset(FX());
  r = await call('POST', '/_test/import', { body: ex });
  check('import with refunds', r.status === 204, sc(r));
  ada = await tok('ada'); bob = await tok('bob');
  r = await refund(bob, Z.payment_id, { amount: latest - refundedSum + 1 });
  check('refunded total rebuilt on import', code(r) === 'refund_exceeds_payment', sc(r));
  if (latest - refundedSum > 0) {
    r = await refund(bob, Z.payment_id, { amount: latest - refundedSum });
    check('remaining refundable exactly', r.status === 201, sc(r));
  }
  const t1 = JSON.parse(JSON.stringify(ex));
  const rp1 = t1.state.payments.find((x) => x.refund_of);
  if (rp1) {
    rp1.refund_of = rp1.payment_id;
    r = await call('POST', '/_test/import', { body: t1 });
    check('tampered refund_of self -> 422', r.status === 422, sc(r));
  }
  const t2 = JSON.parse(JSON.stringify(ex));
  const rp2 = t2.state.payments.find((x) => x.refund_of);
  if (rp2) {
    rp2.refund_of = 'p_nope';
    r = await call('POST', '/_test/import', { body: t2 });
    check('tampered refund_of unknown -> 422', r.status === 422, sc(r));
  }
  // I24: an export whose latest recorded_at runs ahead of the clock
  const t3 = JSON.parse(JSON.stringify(ex));
  const row = t3.state.revisions.find((x) => x[0] === Z.payment_id);
  const ahead = iso(Date.now() + 3000);
  row[1][row[1].length - 1].recorded_at = ahead;
  r = await call('POST', '/_test/import', { body: t3 });
  check('import with revision recorded 3 s ahead', r.status === 204, sc(r));
  ada = await tok('ada');
  const lr = row[1][row[1].length - 1];
  r = await corr(ada, Z.payment_id, C(lr.revision, lr.amount, Z.created_at, 'after ahead'));
  check('I24: new recorded_at strictly after the ahead one', r.status === 201 && Date.parse(r.body.recorded_at) > Date.parse(ahead), sc(r));
  const P2 = await pay(ada, 'bob', 1);
  check('clock not dragged more than ~3 s', Math.abs(Date.parse(P2.created_at) - Date.now()) < 5000, P2.created_at);
  // stage-3 export import
  if (S3BASE) {
    await reset(FX(), S3BASE);
    const a3 = await tok('ada', S3BASE);
    const p3 = await pay(a3, 'bob', 700, {}, S3BASE);
    await call('POST', `/payments/${p3.payment_id}/corrections`, { token: a3, key: k(), body: C(1, 600, p3.created_at), base: S3BASE });
    const ex3 = (await call('GET', '/_test/export', { base: S3BASE })).body;
    r = await call('POST', '/_test/import', { body: ex3 });
    check('stage-3 export imports', r.status === 204, sc(r));
    const b3 = await tok('bob');
    r = await refund(b3, p3.payment_id, { amount: 601 });
    check('imported corrected payment: refund cap = corrected 600', code(r) === 'refund_exceeds_payment', sc(r));
    r = await refund(b3, p3.payment_id, { amount: 600 });
    check('imported: refund 600 ok', r.status === 201, sc(r));
    r = await call('GET', `/payments/${p3.payment_id}/revisions`, { token: b3 });
    check('imported revisions expose correction_batch_id null', r.body.revisions.every((x) => x.correction_batch_id === null), sc(r));
  }
  console.log(out.join('\n'));
  console.log(`${pass} passed, ${fail} failed`);
})().catch((e) => { console.error(e); process.exit(2); });
