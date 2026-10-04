'use strict';
// Pocketful stage 1 — payments, requests, splits, settlements.
// Single process, in-memory state. Every check+mutation runs synchronously in
// one event-loop tick, so the single JS thread linearises all operations.
// The only async work is scrypt password hashing; state is re-checked after it.

const http = require('node:http');
const crypto = require('node:crypto');

const PORT = parseInt(process.env.PORT || '8080', 10) || 8080;
const MAX_BODY = 1 << 20;          // 1 MiB for API requests
const MAX_TEST_BODY = 256 << 20;   // test-control endpoints carry whole states
const MAX_AMOUNT = 1000000000;
const HANDLE_RE = /^[a-z0-9_]{1,20}$/;
const SCRYPT = { N: 2048, r: 8, p: 1, keylen: 32 };

// ---------- errors ----------
class ApiError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
const bad = (m) => new ApiError(400, 'malformed_request', m || 'malformed request');
const invalid = (m) => new ApiError(422, 'validation_failed', m || 'validation failed');
const notFound = (m) => new ApiError(404, 'not_found', m || 'not found');
const forbidden = () => new ApiError(403, 'forbidden', 'not permitted');
const unauth = () => new ApiError(401, 'unauthenticated', 'authentication required');

// ---------- helpers ----------
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cpLen = (s) => { let n = 0; for (const _ of s) n++; return n; };
const cpSlice = (s, n) => Array.from(s).slice(0, n).join('');
const isEmail = (s) => {
  if (/\s/.test(s)) return false;
  const parts = s.split('@');
  return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0;
};
const deriveHandle = (email) =>
  cpSlice(Array.from(email.split('@')[0].toLowerCase()).map((c) => (/^[a-z0-9_]$/.test(c) ? c : '_')).join(''), 20);

function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (isObj(v)) return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
const clone = (v) => JSON.parse(JSON.stringify(v));

let lastMs = 0;
function nowIso() {
  const ms = Math.max(Date.now(), lastMs);
  lastMs = ms;
  return new Date(ms).toISOString().replace('Z', '+00:00');
}

function hashPassword(password, N = SCRYPT.N) {
  const salt = crypto.randomBytes(16);
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT.keylen, { N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) => {
      if (err) reject(err);
      else resolve({ alg: 'scrypt', N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('hex'), hash: key.toString('hex') });
    });
  });
}
function verifyPassword(password, pwd) {
  return new Promise((resolve) => {
    const expected = Buffer.from(pwd.hash, 'hex');
    crypto.scrypt(password, Buffer.from(pwd.salt, 'hex'), expected.length,
      { N: pwd.N, r: pwd.r, p: pwd.p, maxmem: 256 * pwd.N * pwd.r + (1 << 20) }, (err, key) => {
        resolve(!err && key.length === expected.length && crypto.timingSafeEqual(key, expected));
      });
  });
}

// ---------- state ----------
function emptyState(currency, minorUnits) {
  return {
    currency, minorUnits,
    users: new Map(), byEmail: new Map(), byHandle: new Map(), tokens: new Map(),
    payments: [], requests: new Map(), // requests in insertion (creation) order
    operators: new Set(), idem: new Map(), used: new Set(), counter: 0,
  };
}
let state = emptyState('EUR', 2);

function newId(st, prefix) {
  let id;
  do { id = prefix + (++st.counter); } while (st.used.has(id));
  st.used.add(id);
  return id;
}

function issueToken(st, userId) {
  const t = 'tk_' + crypto.randomBytes(24).toString('hex');
  st.tokens.set(t, userId);
  return t;
}

function insertUser(st, u) {
  st.users.set(u.id, u);
  st.byEmail.set(u.email.toLowerCase(), u.id);
  st.byHandle.set(u.handle, u.id);
  st.used.add(u.id);
}

const reqView = (r) => ({ ...r });

// ---------- fixture (reset) ----------
function checkStr(v, max) { return typeof v === 'string' && v.length > 0 && (max === undefined || v.length <= max); }

async function buildFromFixture(fx) {
  if (!isObj(fx)) throw bad('fixture must be a JSON object');
  if (!checkStr(fx.currency)) throw invalid('currency');
  if (![0, 2, 3].includes(fx.minor_units)) throw invalid('minor_units');
  if (!Array.isArray(fx.users)) throw invalid('users');
  const payments = fx.payments == null ? [] : fx.payments;
  const requests = fx.requests == null ? [] : fx.requests;
  const operators = fx.settlement_operator_ids == null ? [] : fx.settlement_operator_ids;
  if (!Array.isArray(payments) || !Array.isArray(requests) || !Array.isArray(operators)) throw invalid('collections');
  const st = emptyState(fx.currency, fx.minor_units);
  const ids = new Set(), emails = new Set(), handles = new Set();
  let total = 0;
  for (const u of fx.users) {
    if (!isObj(u) || !checkStr(u.id, 64) || ids.has(u.id)) throw invalid('user id');
    if (typeof u.email !== 'string' || !isEmail(u.email) || emails.has(u.email.toLowerCase())) throw invalid('user email');
    if (typeof u.password !== 'string' || u.password.length === 0) throw invalid('user password');
    if (typeof u.handle !== 'string' || !HANDLE_RE.test(u.handle) || handles.has(u.handle)) throw invalid('user handle');
    if (u.display_name !== undefined && typeof u.display_name !== 'string') throw invalid('display_name');
    if (!Number.isSafeInteger(u.balance) || u.balance < 0) throw invalid('balance');
    total += u.balance;
    if (!Number.isSafeInteger(total)) throw invalid('total');
    ids.add(u.id); emails.add(u.email.toLowerCase()); handles.add(u.handle);
  }
  const ts = nowIso();
  const pids = new Set();
  const seededPayments = payments.map((p) => {
    if (!isObj(p) || !checkStr(p.id, 64) || pids.has(p.id)) throw invalid('payment id');
    if (!ids.has(p.from_user_id) || !ids.has(p.to_user_id) || p.from_user_id === p.to_user_id) throw invalid('payment users');
    if (!Number.isInteger(p.amount) || p.amount < 1 || p.amount > MAX_AMOUNT) throw invalid('payment amount');
    if (p.note !== undefined && typeof p.note !== 'string') throw invalid('payment note');
    if (p.visibility !== undefined && p.visibility !== 'public' && p.visibility !== 'private') throw invalid('payment visibility');
    pids.add(p.id);
    return p;
  });
  const rids = new Set();
  for (const r of requests) {
    if (!isObj(r) || !checkStr(r.id, 64) || rids.has(r.id)) throw invalid('request id');
    if (!ids.has(r.requester_id) || !ids.has(r.payer_id) || r.requester_id === r.payer_id) throw invalid('request users');
    if (!Number.isInteger(r.amount) || r.amount < 1 || r.amount > MAX_AMOUNT) throw invalid('request amount');
    if (r.note !== undefined && typeof r.note !== 'string') throw invalid('request note');
    if (r.status !== undefined && !['pending', 'paid', 'declined', 'cancelled'].includes(r.status)) throw invalid('request status');
    rids.add(r.id);
  }
  for (const o of operators) if (!ids.has(o)) throw invalid('settlement_operator_ids');

  // One salted scrypt per distinct seeded password (fixtures reuse passwords), so reset
  // time does not grow with the user count; users sharing a password share its record.
  // With very many distinct passwords the scrypt cost steps down (still a salted KDF) so a
  // reset stays well inside its 10 s budget on 2 vCPU; the cost is stored per hash.
  const distinct = [...new Set(fx.users.map((u) => u.password))];
  const N = distinct.length <= 256 ? SCRYPT.N : distinct.length <= 1024 ? SCRYPT.N / 2 : SCRYPT.N / 4;
  const hashed = new Map(await Promise.all(distinct.map(async (pw) => [pw, await hashPassword(pw, N)])));
  fx.users.forEach((u) => insertUser(st, {
    id: u.id, email: u.email, pwd: { ...hashed.get(u.password) },
    display_name: u.display_name === undefined ? u.handle : u.display_name,
    handle: u.handle, balance: u.balance,
  }));
  for (const p of seededPayments) {
    const from = st.users.get(p.from_user_id), to = st.users.get(p.to_user_id);
    st.used.add(p.id);
    st.payments.push({
      payment_id: p.id, from_user_id: from.id, from_handle: from.handle, to_user_id: to.id, to_handle: to.handle,
      amount: p.amount, currency: st.currency, note: p.note === undefined ? '' : p.note,
      visibility: p.visibility === undefined ? 'public' : p.visibility,
      request_id: null, settlement_id: null, created_at: ts,
    });
  }
  for (const r of requests) {
    const rq = st.users.get(r.requester_id), py = st.users.get(r.payer_id);
    st.used.add(r.id);
    st.requests.set(r.id, {
      request_id: r.id, requester_id: rq.id, requester_handle: rq.handle, payer_id: py.id, payer_handle: py.handle,
      amount: r.amount, currency: st.currency, note: r.note === undefined ? '' : r.note,
      status: r.status === undefined ? 'pending' : r.status, payment_id: null, created_at: ts,
    });
  }
  for (const o of operators) st.operators.add(o);
  return st;
}

// ---------- export / import ----------
function exportState(st) {
  return {
    track: 'pocketful', format_version: 1,
    state: clone({
      currency: st.currency, minor_units: st.minorUnits, counter: st.counter,
      users: [...st.users.values()],
      tokens: [...st.tokens.entries()],
      payments: st.payments,
      requests: [...st.requests.values()],
      operators: [...st.operators],
      idempotency: [...st.idem.entries()],
      used_ids: [...st.used],
    }),
  };
}

function importState(doc) {
  if (!isObj(doc)) throw bad('body must be a JSON object');
  if (doc.track !== 'pocketful' || doc.format_version !== 1 || !isObj(doc.state)) throw invalid('not a pocketful v1 export');
  const s = doc.state;
  const need = (c, m) => { if (!c) throw invalid('invalid state: ' + m); };
  need(typeof s.currency === 'string' && s.currency.length > 0, 'currency');
  need([0, 2, 3].includes(s.minor_units), 'minor_units');
  need(Number.isSafeInteger(s.counter) && s.counter >= 0, 'counter');
  for (const k of ['users', 'tokens', 'payments', 'requests', 'operators', 'idempotency', 'used_ids']) need(Array.isArray(s[k]), k);
  const st = emptyState(s.currency, s.minor_units);
  st.counter = s.counter;
  const str = (v) => typeof v === 'string' && v.length > 0;
  for (const u of s.users) {
    need(isObj(u) && str(u.id) && u.id.length <= 64 && !st.users.has(u.id), 'user id');
    need(typeof u.email === 'string' && isEmail(u.email) && !st.byEmail.has(u.email.toLowerCase()), 'user email');
    need(typeof u.handle === 'string' && HANDLE_RE.test(u.handle) && !st.byHandle.has(u.handle), 'user handle');
    need(typeof u.display_name === 'string', 'display_name');
    need(Number.isSafeInteger(u.balance) && u.balance >= 0, 'balance');
    const p = u.pwd;
    need(isObj(p) && p.alg === 'scrypt' && typeof p.salt === 'string' && /^[0-9a-f]+$/.test(p.salt)
      && typeof p.hash === 'string' && /^[0-9a-f]{2,}$/.test(p.hash) && p.hash.length % 2 === 0
      && [p.N, p.r, p.p].every((x) => Number.isSafeInteger(x) && x > 0)
      && (p.N & (p.N - 1)) === 0 && p.N <= 1 << 16 && p.r <= 32 && p.p <= 16, 'password hash');
    insertUser(st, { id: u.id, email: u.email, pwd: { alg: 'scrypt', N: p.N, r: p.r, p: p.p, salt: p.salt, hash: p.hash },
      display_name: u.display_name, handle: u.handle, balance: u.balance });
  }
  for (const t of s.tokens) {
    need(Array.isArray(t) && t.length === 2 && str(t[0]) && st.users.has(t[1]), 'token');
    st.tokens.set(t[0], t[1]);
  }
  const ts = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
  const note = (v) => typeof v === 'string';
  const pids = new Set();
  for (const p of s.payments) {
    need(isObj(p) && str(p.payment_id) && !pids.has(p.payment_id), 'payment id');
    const f = st.users.get(p.from_user_id), t = st.users.get(p.to_user_id);
    need(f && t && p.from_handle === f.handle && p.to_handle === t.handle, 'payment users');
    need(Number.isInteger(p.amount) && p.amount >= 1 && p.amount <= MAX_AMOUNT, 'payment amount');
    need(p.currency === st.currency && note(p.note) && (p.visibility === 'public' || p.visibility === 'private'), 'payment fields');
    need((p.request_id === null || str(p.request_id)) && (p.settlement_id === null || str(p.settlement_id)) && ts(p.created_at), 'payment refs');
    pids.add(p.payment_id);
    st.payments.push({
      payment_id: p.payment_id, from_user_id: p.from_user_id, from_handle: p.from_handle, to_user_id: p.to_user_id,
      to_handle: p.to_handle, amount: p.amount, currency: p.currency, note: p.note, visibility: p.visibility,
      request_id: p.request_id, settlement_id: p.settlement_id, created_at: p.created_at,
    });
  }
  for (const r of s.requests) {
    need(isObj(r) && str(r.request_id) && !st.requests.has(r.request_id), 'request id');
    const a = st.users.get(r.requester_id), b = st.users.get(r.payer_id);
    need(a && b && r.requester_handle === a.handle && r.payer_handle === b.handle, 'request users');
    need(Number.isInteger(r.amount) && r.amount >= 1 && r.amount <= MAX_AMOUNT && r.currency === st.currency && note(r.note), 'request fields');
    need(['pending', 'paid', 'declined', 'cancelled'].includes(r.status) && (r.payment_id === null || pids.has(r.payment_id)) && ts(r.created_at), 'request status');
    st.requests.set(r.request_id, {
      request_id: r.request_id, requester_id: r.requester_id, requester_handle: r.requester_handle,
      payer_id: r.payer_id, payer_handle: r.payer_handle, amount: r.amount, currency: r.currency,
      note: r.note, status: r.status, payment_id: r.payment_id, created_at: r.created_at,
    });
  }
  for (const o of s.operators) { need(st.users.has(o), 'operator'); st.operators.add(o); }
  for (const e of s.idempotency) {
    need(Array.isArray(e) && e.length === 2 && str(e[0]) && isObj(e[1]) && typeof e[1].canon === 'string'
      && Number.isInteger(e[1].status) && e[1].body !== undefined, 'idempotency record');
    st.idem.set(e[0], { canon: e[1].canon, status: e[1].status, body: e[1].body });
  }
  for (const id of s.used_ids) { need(typeof id === 'string', 'used id'); st.used.add(id); }
  for (const id of pids) st.used.add(id);
  for (const id of st.requests.keys()) st.used.add(id);
  return st;
}

// ---------- validation helpers ----------
function parseObjBody(raw, emptyAs) {
  if (raw.length === 0 && emptyAs !== undefined) return emptyAs;
  let v;
  try { v = JSON.parse(raw.toString('utf8')); } catch { throw bad('body is not valid JSON'); }
  if (!isObj(v)) throw bad('body must be a JSON object');
  return v;
}
// Type check for plain string fields: wrong JSON type (incl. null) -> 400; missing -> 422.
function typeStr(body, k) {
  if (has(body, k) && typeof body[k] !== 'string') throw bad(`${k} must be a string`);
}
function reqHandle(body, k) {
  if (!has(body, k)) throw invalid(`${k} is required`);
  return body[k];
}
function checkAmount(v, present) {
  if (!present || typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_AMOUNT) throw invalid('amount must be an integer from 1 to 1000000000');
  return v;
}
function checkNote(body) {
  if (!has(body, 'note')) return '';
  const n = body.note;
  if (typeof n !== 'string' || cpLen(n) > 200) throw invalid('note must be a string of at most 200 characters');
  return n;
}
function checkVisibility(body) {
  if (!has(body, 'visibility')) return 'public';
  if (body.visibility !== 'public' && body.visibility !== 'private') throw invalid('visibility must be public or private');
  return body.visibility;
}
function pageParams(q) {
  const num = (name, def, min, max) => {
    if (!q.has(name)) return def;
    const s = q.get(name);
    if (!/^[0-9]+$/.test(s)) throw invalid(`${name} must be a non-negative decimal integer`);
    const n = Number(s);
    if (n < min || (max !== undefined && n > max)) throw invalid(`${name} out of range`);
    return n;
  };
  return { limit: num('limit', 50, 1, 200), offset: num('offset', 0, 0) };
}
function page(items, { limit, offset }) {
  return { items: items.slice(offset, offset + limit), has_more: items.length > offset + limit };
}

// ---------- domain ----------
function userByHandleOr404(st, h) {
  const id = st.byHandle.get(h);
  if (!id) throw notFound('no user has that handle');
  return st.users.get(id);
}

function makePayment(st, from, to, amount, note, visibility, requestId, settlementId, ts) {
  const p = {
    payment_id: newId(st, 'p_'), from_user_id: from.id, from_handle: from.handle,
    to_user_id: to.id, to_handle: to.handle, amount, currency: st.currency, note, visibility,
    request_id: requestId, settlement_id: settlementId, created_at: ts,
  };
  from.balance -= amount;
  to.balance += amount;
  st.payments.push(p);
  return p;
}

function makeRequest(st, requester, payer, amount, note, ts) {
  const r = {
    request_id: newId(st, 'rq_'), requester_id: requester.id, requester_handle: requester.handle,
    payer_id: payer.id, payer_handle: payer.handle, amount, currency: st.currency, note,
    status: 'pending', payment_id: null, created_at: ts,
  };
  st.requests.set(r.request_id, r);
  return r;
}

const ops = {
  payments(st, me, body) {
    typeStr(body, 'to_handle');
    const h = reqHandle(body, 'to_handle');
    const amount = checkAmount(body.amount, has(body, 'amount'));
    const note = checkNote(body);
    const visibility = checkVisibility(body);
    const to = userByHandleOr404(st, h);
    if (to.id === me.id) throw new ApiError(422, 'self_payment', 'cannot pay yourself');
    if (me.balance < amount) throw new ApiError(409, 'insufficient_funds', 'insufficient funds');
    return makePayment(st, me, to, amount, note, visibility, null, null, nowIso());
  },

  requests(st, me, body) {
    typeStr(body, 'payer_handle');
    const h = reqHandle(body, 'payer_handle');
    const amount = checkAmount(body.amount, has(body, 'amount'));
    const note = checkNote(body);
    const payer = userByHandleOr404(st, h);
    if (payer.id === me.id) throw new ApiError(422, 'self_request', 'cannot request from yourself');
    return reqView(makeRequest(st, me, payer, amount, note, nowIso()));
  },

  pay(st, me, body, reqId) {
    const r = st.requests.get(reqId);
    if (!r) throw notFound('no such request');
    if (r.payer_id !== me.id) throw forbidden();
    const visibility = checkVisibility(body);
    if (r.status !== 'pending') throw new ApiError(409, 'request_not_pending', 'request is not pending');
    const to = st.users.get(r.requester_id);
    if (me.balance < r.amount) throw new ApiError(409, 'insufficient_funds', 'insufficient funds');
    const p = makePayment(st, me, to, r.amount, r.note, visibility, r.request_id, null, nowIso());
    r.status = 'paid';
    r.payment_id = p.payment_id;
    return p;
  },

  splits(st, me, body) {
    if (has(body, 'participant_handles')) {
      const ph = body.participant_handles;
      if (!Array.isArray(ph) || ph.some((x) => typeof x !== 'string')) throw bad('participant_handles must be an array of strings');
    }
    const amount = checkAmount(body.amount, has(body, 'amount'));
    if (!has(body, 'participant_handles')) throw invalid('participant_handles is required');
    const handles = body.participant_handles;
    if (handles.length === 0) throw invalid('participant_handles must not be empty');
    if (new Set(handles).size !== handles.length) throw invalid('participant_handles contains a duplicate');
    const note = checkNote(body);
    const users = handles.map((h) => userByHandleOr404(st, h));
    const n = users.length, base = Math.floor(amount / n), rem = amount - base * n;
    const shares = handles.map((h, i) => ({ handle: h, amount: base + (i < rem ? 1 : 0) }));
    const ts = nowIso();
    const splitId = newId(st, 'sp_');
    const requests = [];
    users.forEach((u, i) => {
      if (u.id !== me.id) requests.push(reqView(makeRequest(st, me, u, shares[i].amount, note, ts)));
    });
    return { split_id: splitId, amount, currency: st.currency, note, shares, requests, created_at: ts };
  },

  settlements(st, me, body) {
    const tr = body.transfers;
    if (!Array.isArray(tr) || tr.length < 1 || tr.length > 32) throw invalid('transfers must be an array of 1 to 32 items');
    // Entries are checked one at a time in input order: the first bad entry decides the error.
    const plan = tr.map((t) => {
      if (!isObj(t)) throw invalid('every transfer must be an object');
      if (typeof t.from_handle !== 'string' || typeof t.to_handle !== 'string') throw invalid('transfer handles must be strings');
      const amount = checkAmount(t.amount, has(t, 'amount'));
      const note = checkNote(t);
      const visibility = checkVisibility(t);
      const from = userByHandleOr404(st, t.from_handle);
      const to = userByHandleOr404(st, t.to_handle);
      if (from.id === to.id) throw new ApiError(422, 'self_payment', 'transfer to the same wallet');
      return { from, to, amount, note, visibility };
    });
    const delta = new Map();
    for (const x of plan) {
      delta.set(x.from.id, (delta.get(x.from.id) || 0) - x.amount);
      delta.set(x.to.id, (delta.get(x.to.id) || 0) + x.amount);
    }
    for (const [uid, d] of delta) {
      if (st.users.get(uid).balance + d < 0) throw new ApiError(409, 'insufficient_funds', 'settlement is not affordable');
    }
    // Apply credits/debits net per wallet so no balance is ever negative, then record payments.
    const ts = nowIso();
    const sid = newId(st, 'st_');
    const payments = plan.map((x) => {
      const p = {
        payment_id: newId(st, 'p_'), from_user_id: x.from.id, from_handle: x.from.handle,
        to_user_id: x.to.id, to_handle: x.to.handle, amount: x.amount, currency: st.currency,
        note: x.note, visibility: x.visibility, request_id: null, settlement_id: sid, created_at: ts,
      };
      st.payments.push(p);
      return p;
    });
    for (const [uid, d] of delta) st.users.get(uid).balance += d;
    return { settlement_id: sid, committed_at: ts, payments };
  },
};

// ---------- routing ----------
function send(res, status, obj) {
  if (res.headersSent || res.writableEnded) return;
  if (status === 204 || obj === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const data = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length });
  res.end(data);
}
function sendError(res, e) {
  send(res, e.status, { error: { code: e.code, message: e.message } });
}

function authenticate(st, req) {
  const h = req.headers.authorization;
  if (typeof h !== 'string') throw unauth();
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(h);
  if (!m) throw unauth();
  const uid = st.tokens.get(m[1]);
  if (!uid) throw unauth();
  return st.users.get(uid);
}

function idemKey(req) {
  const k = req.headers['idempotency-key'];
  if (k === undefined || k === '') throw new ApiError(400, 'missing_idempotency_key', 'Idempotency-Key header is required');
  const len = cpLen(Buffer.from(k, 'latin1').toString('utf8'));
  if (len < 1 || len > 255) throw invalid('Idempotency-Key must be 1 to 255 characters');
  return k;
}

// Idempotent write: auth -> body -> [operator] -> key -> replay/reuse -> operation.
function idempotent(req, res, raw, path, opName, opts) {
  const st = state;
  const me = authenticate(st, req);
  const body = parseObjBody(raw, opts.emptyAs);
  if (opts.operatorOnly && !st.operators.has(me.id)) throw forbidden();
  const key = idemKey(req);
  const rk = me.id + '\u0000POST\u0000' + path + '\u0000' + key;
  const c = canon(body);
  const prior = st.idem.get(rk);
  if (prior) {
    if (prior.canon !== c) throw new ApiError(409, 'idempotency_key_reuse', 'key already used with a different body');
    return send(res, 200, prior.body);
  }
  const result = clone(ops[opName](st, me, body, opts.arg));
  st.idem.set(rk, { canon: c, status: 201, body: result });
  send(res, 201, result);
}

function decideRequest(st, me, id, action) {
  const r = st.requests.get(id);
  if (!r) throw notFound('no such request');
  const owner = action === 'decline' ? r.payer_id : r.requester_id;
  if (owner !== me.id) throw forbidden();
  const target = action === 'decline' ? 'declined' : 'cancelled';
  if (r.status === target) return reqView(r);
  if (r.status !== 'pending') throw new ApiError(409, 'request_not_pending', 'request is not pending');
  r.status = target;
  return reqView(r);
}

async function signup(req, res, raw) {
  const body = parseObjBody(raw);
  for (const k of ['email', 'password', 'display_name']) typeStr(body, k);
  for (const k of ['email', 'password']) if (!has(body, k)) throw invalid(`${k} is required`);
  const { email, password } = body;
  if (!isEmail(email)) throw invalid('email must be of the form local@domain');
  if (cpLen(password) < 8) throw invalid('password must be at least 8 characters');
  const handle = deriveHandle(email);
  // display_name is optional (no rule in §6): defaults to the derived handle, stored verbatim.
  const display_name = has(body, 'display_name') ? body.display_name : handle;
  const conflicts = (st) => {
    if (st.byEmail.has(email.toLowerCase())) throw new ApiError(409, 'email_taken', 'email already registered');
    if (!HANDLE_RE.test(handle)) throw invalid('cannot derive a handle from this email');
    if (st.byHandle.has(handle)) throw new ApiError(409, 'handle_taken', 'derived handle is taken');
  };
  // Commit into the state captured at request start: if a reset/import replaced it
  // while hashing, this account goes into the discarded state and is never visible.
  const st = state;
  conflicts(st);
  const pwd = await hashPassword(password);
  conflicts(st);
  const user = { id: newId(st, 'u_'), email, pwd, display_name, handle, balance: 0 };
  insertUser(st, user);
  send(res, 201, { user_id: user.id, display_name, token: issueToken(st, user.id) });
}

async function login(req, res, raw) {
  const body = parseObjBody(raw);
  typeStr(body, 'email'); typeStr(body, 'password');
  if (!has(body, 'email') || !has(body, 'password')) throw invalid('email and password are required');
  const st = state;
  const uid = st.byEmail.get(body.email.toLowerCase());
  const user = uid && st.users.get(uid);
  if (!user) throw unauth();
  const ok = await verifyPassword(body.password, user.pwd);
  if (!ok) throw unauth();
  send(res, 200, { user_id: user.id, display_name: user.display_name, token: issueToken(st, user.id) });
}

const ROUTES = [
  ['GET', /^\/health$/, (req, res) => send(res, 200, { status: 'ok' })],
  ['POST', /^\/_test\/reset$/, async (req, res, raw) => {
    const fx = parseObjBody(raw);
    state = await buildFromFixture(fx);
    send(res, 204);
  }],
  ['GET', /^\/_test\/export$/, (req, res) => send(res, 200, exportState(state))],
  ['POST', /^\/_test\/import$/, (req, res, raw) => {
    const doc = parseObjBody(raw);
    state = importState(doc);
    send(res, 204);
  }],
  ['POST', /^\/auth\/signup$/, signup],
  ['POST', /^\/auth\/login$/, login],
  ['GET', /^\/me$/, (req, res) => {
    const st = state, me = authenticate(st, req);
    send(res, 200, { user_id: me.id, display_name: me.display_name, handle: me.handle, balance: me.balance,
      currency: st.currency, minor_units: st.minorUnits });
  }],
  ['POST', /^\/payments$/, (req, res, raw, m, path) => idempotent(req, res, raw, path, 'payments', {})],
  ['POST', /^\/requests$/, (req, res, raw, m, path) => idempotent(req, res, raw, path, 'requests', {})],
  ['GET', /^\/requests$/, (req, res, raw, m, path, q) => {
    const st = state, me = authenticate(st, req);
    const dir = q.has('direction') ? q.get('direction') : null;
    if (dir !== null && dir !== 'incoming' && dir !== 'outgoing') throw invalid('direction must be incoming or outgoing');
    const status = q.has('status') ? q.get('status') : null;
    if (status !== null && !['pending', 'paid', 'declined', 'cancelled'].includes(status)) throw invalid('unknown status');
    const pg = pageParams(q);
    const items = [];
    const all = [...st.requests.values()];
    for (let i = all.length - 1; i >= 0; i--) {
      const r = all[i];
      const mine = dir === 'incoming' ? r.payer_id === me.id
        : dir === 'outgoing' ? r.requester_id === me.id
          : r.payer_id === me.id || r.requester_id === me.id;
      if (mine && (status === null || r.status === status)) items.push(r);
    }
    const p = page(items, pg);
    send(res, 200, { requests: p.items.map(reqView), has_more: p.has_more });
  }],
  ['POST', /^\/requests\/([^/]+)\/pay$/, (req, res, raw, m, path) =>
    idempotent(req, res, raw, path, 'pay', { emptyAs: {}, arg: m[1] })],
  ['POST', /^\/requests\/([^/]+)\/(decline|cancel)$/, (req, res, raw, m) => {
    const st = state, me = authenticate(st, req);
    send(res, 200, decideRequest(st, me, m[1], m[2]));
  }],
  ['POST', /^\/splits$/, (req, res, raw, m, path) => idempotent(req, res, raw, path, 'splits', {})],
  ['GET', /^\/activity$/, (req, res, raw, m, path, q) => {
    const st = state, me = authenticate(st, req);
    const pg = pageParams(q);
    const items = [];
    for (let i = st.payments.length - 1; i >= 0; i--) {
      const p = st.payments[i];
      if (p.visibility === 'public' || p.from_user_id === me.id || p.to_user_id === me.id) items.push(p);
    }
    const p = page(items, pg);
    send(res, 200, { payments: p.items, has_more: p.has_more });
  }],
  ['POST', /^\/settlements$/, (req, res, raw, m, path) =>
    idempotent(req, res, raw, path, 'settlements', { operatorOnly: true })],
];

function decodeMatch(m) {
  return m.map((s, i) => (i === 0 ? s : decodeURIComponent(s)));
}

async function handle(req, res, raw, path, q, route, m) {
  try {
    await route[2](req, res, raw, m, path, q);
  } catch (e) {
    if (e instanceof ApiError) return sendError(res, e);
    console.error(e);
    sendError(res, new ApiError(500, 'internal_error', 'internal error'));
  }
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { url = null; }
  if (!url) { req.resume(); return sendError(res, bad('bad request target')); }
  const path = url.pathname;
  let route = null, m = null, pathKnown = false;
  for (const r of ROUTES) {
    const mm = r[1].exec(path);
    if (!mm) continue;
    pathKnown = true;
    if (r[0] === req.method) {
      try { m = decodeMatch(mm); route = r; } catch { m = null; }
      if (route) break;
    }
  }
  if (!route) {
    req.resume();
    if (pathKnown && m === null && ROUTES.some((r) => r[0] === req.method && r[1].test(path))) return sendError(res, notFound());
    return pathKnown ? sendError(res, new ApiError(405, 'method_not_allowed', 'method not allowed'))
      : sendError(res, notFound());
  }
  const limit = path.startsWith('/_test/') ? MAX_TEST_BODY : MAX_BODY;
  const chunks = [];
  let size = 0, aborted = false;
  req.on('data', (c) => {
    if (aborted) return;
    size += c.length;
    if (size > limit) {
      aborted = true;
      sendError(res, new ApiError(413, 'payload_too_large', 'request body too large'));
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => { if (!aborted) handle(req, res, Buffer.concat(chunks), path, url.searchParams, route, m); });
  req.on('error', () => {});
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 0;
server.on('clientError', (err, socket) => {
  if (socket.writable) {
    const body = JSON.stringify({ error: { code: 'malformed_request', message: 'bad request' } });
    socket.end(`HTTP/1.1 400 Bad Request\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  } else socket.destroy();
});
server.listen(PORT, '0.0.0.0', () => console.log(`pocketful stage 1 listening on 0.0.0.0:${PORT}`));
