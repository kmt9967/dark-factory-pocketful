'use strict';
// Reviewer round-2 probes (rev 9984923): D11 ordering, D12 reset hashing, D13, D14.
// Usage: BASE=http://127.0.0.1:19090 node stage-1/review/rev2-probe.js
const BASE = process.env.BASE || 'http://127.0.0.1:19090';
let pass = 0, fail = 0; const out = [];
const check = (n, c, d) => { if (c) pass++; else { fail++; out.push(`FAIL ${n} :: ${d}`); } };
async function call(method, p, { body, raw, token, key } = {}) {
  const h = {};
  if (token) h.authorization = `Bearer ${token}`;
  if (key !== undefined) h['idempotency-key'] = key;
  const payload = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined;
  const t0 = Date.now();
  const r = await fetch(BASE + p, { method, headers: h, body: payload });
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  return { status: r.status, body: j, ms: Date.now() - t0 };
}
const code = (r) => r.body && r.body.error && r.body.error.code;
const sc = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`;
let n = 0; const k = () => `r2_${Date.now()}_${n++}`;
const U = (h, bal, pw = 'correct horse') => ({ id: `u_${h}`, email: `${h}@example.com`, password: pw, display_name: h, handle: h, balance: bal });
const login = async (h, pw = 'correct horse') => call('POST', '/auth/login', { body: { email: `${h}@example.com`, password: pw } });

(async () => {
  let r = await call('POST', '/_test/reset', { body: { currency: 'EUR', minor_units: 2,
    users: [U('ada', 1000), U('bob', 0, 'other password'), U('cy', 0), U('op', 0)], settlement_operator_ids: ['u_op'] } });
  check('reset', r.status === 204, sc(r));
  const ada = (await login('ada')).body.token, op = (await login('op')).body.token;
  r = await login('bob', 'other password'); check('bob distinct pw login', r.status === 200, sc(r));
  r = await login('bob'); check('bob wrong (shared other) pw -> 401', r.status === 401, sc(r));
  r = await login('cy', 'other password'); check('cy wrong pw -> 401', r.status === 401, sc(r));
  r = await login('cy'); check('cy shared pw login', r.status === 200, sc(r));

  // D11 + D2 ordering
  const sites = [
    ['POST', '/payments', (h, a) => ({ to_handle: h, amount: a })],
    ['POST', '/requests', (h, a) => ({ payer_handle: h, amount: a })],
    ['POST', '/splits', (h, a) => ({ participant_handles: ['bob', h], amount: a })],
  ];
  for (const [m, p, mk] of sites) {
    for (const h of ['BOB', '', 'no-such', 'a'.repeat(64), '__proto__', 'constructor']) {
      r = await call(m, p, { token: ada, key: k(), body: mk(h, 1) });
      check(`${p} ${JSON.stringify(h)} -> 404`, r.status === 404 && code(r) === 'not_found', sc(r));
      r = await call(m, p, { token: ada, key: k(), body: mk(h, 0) });
      check(`${p} ${JSON.stringify(h)} + amount 0 -> 422`, r.status === 422, sc(r));
    }
    r = await call(m, p, { token: ada, key: k(), body: { ...mk('BOB', 1), note: 5 } });
    check(`${p} unknown handle + note 5 -> 422`, r.status === 422, sc(r));
  }
  r = await call('POST', '/splits', { token: ada, key: k(), body: { participant_handles: ['BOB', 'BOB'], amount: 5 } });
  check('splits duplicate unknown -> 422 (dup before 404)', r.status === 422, sc(r));
  r = await call('POST', '/splits', { token: ada, key: k(), body: { participant_handles: [], amount: 5 } });
  check('splits empty -> 422', r.status === 422, sc(r));
  r = await call('POST', '/splits', { token: ada, key: k(), body: { participant_handles: ['bob', 7], amount: 5 } });
  check('splits non-string element -> 400', r.status === 400, sc(r));
  r = await call('POST', '/payments', { token: ada, key: k(), body: { to_handle: 'ada', amount: 1 } });
  check('self payment -> 422 self_payment', r.status === 422 && code(r) === 'self_payment', sc(r));

  // D13 settlements
  const S = (transfers) => call('POST', '/settlements', { token: op, key: k(), body: { transfers } });
  r = await S([{ from_handle: 'zz', to_handle: 'bob', amount: 1 }, 5]);
  check('D13 entry0 404 beats entry1 non-object', r.status === 404, sc(r));
  r = await S([{ from_handle: 'ada', to_handle: 'bob', amount: 0 }, 5]);
  check('D13 entry0 422 amount', r.status === 422 && /amount/.test(r.body.error.message), sc(r));
  r = await S([{ from_handle: 'ada', to_handle: 'bob', amount: 1 }, 5]);
  check('D13 entry1 non-object -> 422', r.status === 422, sc(r));
  r = await S([{ from_handle: 'ada', to_handle: 'ada', amount: 1 }, { from_handle: 'BOB', to_handle: 'bob', amount: 1 }]);
  check('D13 self first -> self_payment', r.status === 422 && code(r) === 'self_payment', sc(r));
  r = await S([{ from_handle: 'BOB', to_handle: 'bob', amount: 1 }, { from_handle: 'ada', to_handle: 'ada', amount: 1 }]);
  check('D13 unknown "BOB" first -> 404', r.status === 404, sc(r));
  r = await S([{ from_handle: 'ada', to_handle: 'bob', amount: 1 }, { from_handle: 5, to_handle: 'bob', amount: 1 }]);
  check('D13 non-string handle -> 422', r.status === 422, sc(r));
  r = await S([{ from_handle: 'cy', to_handle: 'bob', amount: 10 }, { from_handle: 'ada', to_handle: 'zz', amount: 1 }]);
  check('entry 404 before funds', r.status === 404, sc(r));
  for (const t of [[], 'x', null, Array(33).fill({ from_handle: 'ada', to_handle: 'bob', amount: 1 })]) {
    r = await S(t); check(`batch shape ${JSON.stringify(t).slice(0, 20)} -> 422`, r.status === 422, sc(r));
  }
  r = await S([{ from_handle: 'ada', to_handle: 'bob', amount: 10, extra: 1 }, { from_handle: 'bob', to_handle: 'cy', amount: 10 }]);
  check('valid chain 201', r.status === 201 && r.body.payments.length === 2, sc(r));

  // D14 signup display_name
  r = await call('POST', '/auth/signup', { body: { email: 'No.Name@x.com', password: '12345678' } });
  check('D14 omitted -> 201 display_name=derived handle', r.status === 201 && r.body.display_name === 'no_name', sc(r));
  r = await call('GET', '/me', { token: r.body.token });
  check('D14 /me display_name', r.body.display_name === 'no_name' && r.body.handle === 'no_name', sc(r));
  r = await call('POST', '/auth/signup', { body: { email: 'empty@x.com', password: '12345678', display_name: '' } });
  check('D14 empty -> 201 verbatim', r.status === 201 && r.body.display_name === '', sc(r));
  r = await call('POST', '/auth/signup', { body: { email: 'sp@x.com', password: '12345678', display_name: '  Zoë 👍 ' } });
  check('D14 verbatim', r.status === 201 && r.body.display_name === '  Zoë 👍 ', sc(r));
  for (const v of [null, 5, true, ['a'], {}]) {
    r = await call('POST', '/auth/signup', { body: { email: `t${n++}@x.com`, password: '12345678', display_name: v } });
    check(`D14 display_name ${JSON.stringify(v)} -> 400`, r.status === 400 && code(r) === 'malformed_request', sc(r));
  }
  r = await call('POST', '/auth/login', { body: { email: 'no.name@x.com', password: '12345678' } });
  check('login after D14 signup', r.status === 200 && r.body.display_name === 'no_name', sc(r));

  // export: no plaintext; import -> logins still work
  const ex = await call('GET', '/_test/export');
  const s = JSON.stringify(ex.body);
  check('export has no plaintext', !s.includes('correct horse') && !s.includes('other password') && !s.includes('12345678'), 'plaintext');
  r = await call('POST', '/_test/import', { body: ex.body }); check('import 204', r.status === 204, sc(r));
  r = await login('cy'); check('shared-hash login after import', r.status === 200, sc(r));
  r = await login('bob', 'other password'); check('distinct login after import', r.status === 200, sc(r));
  r = await call('GET', '/me', { token: ada }); check('old token valid after import', r.status === 200, sc(r));

  // D12 timing: shared and distinct passwords, then logins against reduced-cost hashes
  for (const [users, distinct] of [[1000, false], [2000, false], [256, true], [257, true], [1000, true], [1025, true], [2000, true]]) {
    const fx = { currency: 'JPY', minor_units: 0, users: Array.from({ length: users }, (_, i) => U('u' + i, 5, distinct ? 'password-' + i : 'correct horse')) };
    const t0 = Date.now();
    r = await call('POST', '/_test/reset', { body: fx });
    const ms = Date.now() - t0;
    console.log(`reset ${users} users distinct=${distinct}: ${r.status} ${ms} ms`);
    check(`reset ${users} distinct=${distinct} < 10s`, r.status === 204 && ms < 10000, `${ms} ms`);
    const ls = await Promise.all(Array.from({ length: 50 }, (_, i) => login('u' + (i * 7 % users), distinct ? 'password-' + (i * 7 % users) : 'correct horse')));
    const mx = Math.max(...ls.map((x) => x.ms));
    check(`50 logins after reset ${users}/${distinct} ok < 5s`, ls.every((x) => x.status === 200) && mx < 5000, `${ls.map((x) => x.status).filter((x) => x !== 200).length} bad, max ${mx}`);
    const wrong = await login('u1', 'nope-nope');
    check('wrong pw 401', wrong.status === 401, sc(wrong));
  }

  console.log(out.join('\n'));
  console.log(`${pass} passed, ${fail} failed`);
})().catch((e) => { console.error(e); process.exit(2); });
