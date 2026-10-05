'use strict';
// Reviewer round-2 probes for W3a (rev 9c60409): G9 clock floor cap (import + reset), read-instant
// semantics, G10 compact snapshots (output identity, export/import of snapshots, memory).
// Usage: BASE=<s3> [S2BASE=<s2>] node stage-3/review/rev-w3a-r2-probe.js
const BASE = process.env.BASE || 'http://127.0.0.1:19090';
const S2BASE = process.env.S2BASE;
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
const sc = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`;
let n = 0; const k = () => `r2_${Date.now()}_${n++}`;
const U = (h, bal) => ({ id: `u_${h}`, email: `${h}@example.com`, password: 'correct horse', display_name: h, handle: h, balance: bal });
const iso = (ms) => new Date(ms).toISOString().replace('Z', '+00:00');
const E = encodeURIComponent;
const H = 3600e3;
const reset = (fx, base = BASE) => call('POST', '/_test/reset', { body: fx, base });
const tok = async (h, base = BASE) => (await call('POST', '/auth/login', { body: { email: `${h}@example.com`, password: 'correct horse' }, base })).body.token;
const pay = (t, to, amount, base = BASE) => call('POST', '/payments', { token: t, key: k(), body: { to_handle: to, amount }, base });
const skewOf = (r) => Date.parse(r.body.created_at) - Date.now();

(async () => {
  const now = Date.now();
  // ---- G9: future-dated deadlines and seeded instants never drag the clock (import, round trip, reset) ----
  const fxFuture = { currency: 'EUR', minor_units: 2, users: [U('ada', 10000), U('bob', 0)], authorizations: [
    { id: 'a_fx', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 10, status: 'expired', expires_at: iso(now + 5 * H) },
    { id: 'a_fc', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 10, status: 'open', expires_at: iso(now + 9 * H), created_at: iso(now + 3 * H) }] };
  let r = await reset(fxFuture);
  check('reset with future-dated seeded hold instants', r.status === 204, sc(r));
  let ada = await tok('ada');
  r = await pay(ada, 'bob', 1);
  check('after reset: created_at ≈ wall', Math.abs(skewOf(r)) < 2000, `${r.body.created_at} skew ${skewOf(r)}`);
  const ex = (await call('GET', '/_test/export')).body;
  r = await call('POST', '/_test/import', { body: ex });
  check('round-trip import', r.status === 204, sc(r));
  r = await pay(ada, 'bob', 1);
  check('after stage-3 round trip: created_at ≈ wall', Math.abs(skewOf(r)) < 2000, `skew ${skewOf(r)}`);
  const tampered = JSON.parse(JSON.stringify(ex)); tampered.state.clock_ms = now + 50 * H;
  r = await call('POST', '/_test/import', { body: tampered });
  r = await pay(ada, 'bob', 1);
  check('import with clock_ms far ahead: still ≈ wall', Math.abs(skewOf(r)) < 2000, `skew ${skewOf(r)}`);
  await reset({ currency: 'EUR', minor_units: 2, users: [U('ada', 100), U('bob', 0)] });
  ada = await tok('ada');
  r = await pay(ada, 'bob', 1);
  check('after later reset: ≈ wall', Math.abs(skewOf(r)) < 2000, `skew ${skewOf(r)}`);
  if (S2BASE) {
    await reset(fxFuture, S2BASE);
    const ex2 = (await call('GET', '/_test/export', { base: S2BASE })).body;
    r = await call('POST', '/_test/import', { body: ex2 });
    check('stage-2 export with future expired hold imports', r.status === 204, sc(r));
    await reset({ currency: 'EUR', minor_units: 2, users: [U('ada', 100), U('bob', 0)] });
    ada = await tok('ada');
    r = await pay(ada, 'bob', 1);
    check('after stage-2 import + reset: ≈ wall', Math.abs(skewOf(r)) < 2000, `skew ${skewOf(r)}`);
  }

  // ---- read-instant semantics ----
  await reset({ currency: 'EUR', minor_units: 2, users: [U('ada', 1000000), U('bob', 0)] });
  ada = await tok('ada');
  let misses = 0, metaMiss = 0;
  for (let i = 0; i < 100; i++) {
    const p = await pay(ada, 'bob', 1);
    const s = await call('GET', '/statement?limit=1&offset=' + i, { token: ada });
    if (!s.body.entries.length || s.body.entries[0].payment.payment_id !== p.body.payment_id) misses++;
    const m = await call('GET', '/me', { token: ada });
    if (m.body.balance !== 1000000 - (i + 1)) metaMiss++;
  }
  check('statement default `to` always includes the write just made (100 tries)', misses === 0, `${misses} misses`);
  check('/me reflects the write just made', metaMiss === 0, `${metaMiss}`);
  // concurrent writes keep strictly increasing distinct instants; reads do not advance the clock
  const ws = await Promise.all(Array.from({ length: 50 }, () => pay(ada, 'bob', 1)));
  const tsv = ws.map((x) => Date.parse(x.body.created_at));
  check('50 concurrent writes distinct instants', new Set(tsv).size === 50 && ws.every((x) => x.status === 201), '');
  const t0 = Date.now(); let reads = 0;
  while (Date.now() - t0 < 2000) { await Promise.all(Array.from({ length: 50 }, () => call('GET', '/me?as_of=' + E(iso(Date.now())), { token: ada }))); reads += 50; }
  r = await pay(ada, 'bob', 1);
  check(`no drift after ${reads} temporal reads`, Math.abs(skewOf(r)) < 500, `skew ${skewOf(r)}`);
  // a snapshot's frozen default `to` excludes later writes, even within the same ms
  const s1 = await call('GET', '/statement?limit=1', { token: ada });
  const cnt = s1.body.closing_balance;
  await Promise.all(Array.from({ length: 20 }, () => pay(ada, 'bob', 1)));
  r = await call('GET', `/statement?snapshot=${s1.body.snapshot}&limit=1&offset=0`, { token: ada });
  check('snapshot default to frozen', r.body.closing_balance === cnt, sc(r));

  // ---- G10: compact snapshots render identically; export/import of snapshots ----
  await reset({ currency: 'EUR', minor_units: 2, users: [U('ada', 100000), U('bob', 100000)],
    payments: [{ id: 'p_seed', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 5, note: 'n😀', visibility: 'private', created_at: iso(now - H) }] });
  ada = await tok('ada'); const bob = await tok('bob');
  for (let i = 0; i < 30; i++) await pay(i % 2 ? ada : bob, i % 2 ? 'bob' : 'ada', 10 + i);
  const fresh = await call('GET', '/statement?limit=200', { token: ada });
  const snapTok = fresh.body.snapshot;
  const paged = [];
  for (let off = 0; off < 31; off += 7) paged.push(...(await call('GET', `/statement?snapshot=${snapTok}&limit=7&offset=${off}`, { token: ada })).body.entries);
  check('snapshot pages == first response entries exactly', JSON.stringify(paged) === JSON.stringify(fresh.body.entries), `${paged.length} vs ${fresh.body.entries.length}`);
  r = await call('GET', `/statement?snapshot=${snapTok}&limit=200`, { token: ada });
  check('snapshot full page equals first response (except has_more/snapshot)', JSON.stringify({ ...r.body }) === JSON.stringify({ ...fresh.body }), sc(r));
  const exs = (await call('GET', '/_test/export')).body;
  await reset({ currency: 'EUR', minor_units: 2, users: [U('zz', 1)] });
  r = await call('POST', '/_test/import', { body: exs });
  check('import with snapshots', r.status === 204, sc(r));
  r = await call('GET', `/statement?snapshot=${snapTok}&limit=200`, { token: ada });
  check('imported snapshot renders identically', JSON.stringify(r.body) === JSON.stringify(fresh.body), sc(r));
  for (const [nm, mut] of [
    ['unknown payment ref', (s) => { s.snapshots[0][1].entries[0][0] = 'p_nope'; }],
    ['revision out of range', (s) => { s.snapshots[0][1].entries[0][1] = 9; }],
    ['non-integer delta', (s) => { s.snapshots[0][1].entries[0][2] = 1.5; }],
    ['short row', (s) => { s.snapshots[0][1].entries[0] = ['p_seed', 1]; }],
    ['unknown owner', (s) => { s.snapshots[0][1].owner = 'u_nope'; }]]) {
    const d = JSON.parse(JSON.stringify(exs)); mut(d.state);
    r = await call('POST', '/_test/import', { body: d });
    check(`tampered snapshot ${nm} -> 422`, r.status === 422, sc(r));
  }
  r = await call('GET', `/statement?snapshot=${snapTok}&limit=1`, { token: ada });
  check('state intact after tampered imports', r.status === 200, sc(r));
  // many snapshots: no 5xx, still fast
  const tm = Date.now();
  for (let i = 0; i < 20; i++) await Promise.all(Array.from({ length: 50 }, () => call('GET', '/statement?limit=1', { token: ada })));
  r = await call('GET', '/health');
  check('1000 statements created quickly, service healthy', r.status === 200 && Date.now() - tm < 30000, `${Date.now() - tm} ms`);

  console.log(out.join('\n'));
  console.log(`${pass} passed, ${fail} failed`);
})().catch((e) => { console.error(e); process.exit(2); });
