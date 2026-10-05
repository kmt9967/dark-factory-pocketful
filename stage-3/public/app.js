// Pocketful web app (stage 2). Plain browser JavaScript, no dependencies, served by the API
// process. Client-side routing over /, /requests, /split, /authorizations, /login, /signup.
(() => {
  'use strict';

  const TOKEN_KEY = 'pocketful.token';
  const PROTECTED = ['/', '/requests', '/split', '/authorizations'];
  const PUBLIC = ['/login', '/signup'];
  const root = document.getElementById('app');

  let token = localStorage.getItem(TOKEN_KEY);
  let me = null;               // last applied GET /me
  let renderCounter = 0;

  // ---------- small DOM helper ----------
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    let value;
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'testid') el.setAttribute('data-testid', v);
      else if (k === 'value') value = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'checked' || k === 'disabled') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    if (value !== undefined) el.value = value;
    return el;
  }
  const fill = (el, ...children) => { el.replaceChildren(); for (const c of children.flat(Infinity)) if (c) el.append(c); return el; };

  // ---------- money and time ----------
  const mu = () => (me ? me.minor_units : 2);
  const cur = () => (me ? me.currency : '');
  function decimal(minor, units = mu()) {
    const s = String(minor);
    if (units === 0) return s;
    const p = s.padStart(units + 1, '0');
    return p.slice(0, -units) + '.' + p.slice(-units);
  }
  const money = (minor) => `${decimal(minor)} ${cur()}`;
  // E8: trimmed, digits with at most minor_units decimals; "15." and ".5" rejected; 1..1e9 minor units.
  function parseAmount(text) {
    const s = String(text).trim();
    const units = mu();
    const re = units === 0 ? /^\d+$/ : new RegExp(`^\\d+(\\.\\d{1,${units}})?$`);
    if (s === '') return { error: 'Enter an amount.' };
    if (!re.test(s)) {
      if (/^\d*\.\d+$/.test(s) || /^\d+\.$/.test(s)) {
        return { error: units === 0 ? `${cur()} amounts are whole numbers, without decimals.`
          : `Use at most ${units} decimal places, like ${decimal(1550, units)}.` };
      }
      return { error: 'Enter the amount as a number, like ' + (units === 0 ? '1500' : decimal(1500, units)) + '.' };
    }
    const [ip, fp = ''] = s.split('.');
    const intPart = ip.replace(/^0+(?=\d)/, '');
    if (intPart.length > 12) return { error: 'That amount is too large.' };
    const minor = Number(intPart) * 10 ** units + Number(fp.padEnd(units, '0') || '0');
    if (minor < 1) return { error: 'The amount must be more than zero.' };
    if (minor > 1000000000) return { error: `The most you can move at once is ${money(1000000000)}.` };
    return { minor };
  }
  function shareSplit(amount, n) {
    const base = Math.floor(amount / n), rem = amount - base * n;
    return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
  }
  function when(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const now = new Date();
    const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return `Today, ${t}`;
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return `Yesterday, ${t}`;
    const opts = { day: 'numeric', month: 'short' };
    if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
    return `${d.toLocaleDateString([], opts)}, ${t}`;
  }
  function relative(iso) {
    const ms = new Date(iso).getTime() - Date.now();
    if (Number.isNaN(ms)) return '';
    const abs = Math.abs(ms), min = Math.round(abs / 60000);
    const span = abs < 60000 ? 'less than a minute' : min < 60 ? `${min} min` : min < 2880 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} days`;
    return ms > 0 ? `in ${span}` : `${span} ago`;
  }
  const timeEl = (iso, cls = 'time') => h('time', { class: cls, datetime: iso, title: iso }, when(iso));

  // ---------- API ----------
  function newKey() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const b = new Uint8Array(16); crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  // Result kinds: ok (2xx), refused (4xx, a confirmed rejection), lost (no usable answer: network
  // failure, abort, 5xx or unreadable body — the outcome is unknown), unauth (401, session gone).
  async function api(method, path, { body, key, auth = true } = {}) {
    const headers = { Accept: 'application/json' };
    if (auth && token) headers.Authorization = `Bearer ${token}`;
    if (key) headers['Idempotency-Key'] = key;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    } catch {
      return { kind: 'lost' };
    }
    let data = null;
    if (res.status !== 204) {
      try { data = await res.json(); } catch { return { kind: 'lost', status: res.status }; }
    }
    if (res.status >= 500) return { kind: 'lost', status: res.status };
    if (res.status === 401 && auth) { signOut(); return { kind: 'unauth' }; }
    if (res.status >= 400) {
      const e = (data && data.error) || {};
      return { kind: 'refused', status: res.status, code: e.code || 'error', message: e.message || 'Request refused' };
    }
    return { kind: 'ok', status: res.status, data };
  }

  // Latest read wins (E10): each view numbers its loads and applies a response only if no newer
  // load has been applied already, so a delayed earlier read never overwrites a later one.
  const issued = {}, applied = {};
  async function load(view, path) {
    const n = (issued[view] = (issued[view] || 0) + 1);
    const r = await api('GET', path);
    if (r.kind !== 'ok') return null;
    if (n <= (applied[view] || 0)) return null;
    applied[view] = n;
    return r.data;
  }

  // Idempotent forms (E9): an identical body reuses the key (a replay), any change mints a new one.
  const forms = {};
  function formState(name, defaults) {
    if (!forms[name]) forms[name] = { values: { ...defaults }, key: null, lastBody: null, busy: false, msg: null };
    return forms[name];
  }
  async function idemSend(f, path, body) {
    const sig = JSON.stringify([path, body]);
    if (f.lastBody !== sig || !f.key) { f.key = newKey(); f.lastBody = sig; }
    return api('POST', path, { body, key: f.key });
  }

  function explain(r, fallback) {
    const byCode = {
      insufficient_funds: 'Not enough available funds. Money on hold can’t be spent.',
      not_found: 'We couldn’t find that person or item. Check the handle and try again.',
      self_payment: 'You can’t send money to yourself.',
      self_request: 'You can’t request money from yourself.',
      request_not_pending: 'This request has already been settled elsewhere.',
      authorization_not_open: 'This hold is already closed.',
      authorization_expired: 'This hold has expired, so the funds were released.',
      capture_exceeds_authorization: 'That’s more than what remains on this hold.',
      forbidden: 'You aren’t allowed to do that.',
      email_taken: 'An account with this email already exists.',
      handle_taken: 'The handle from this email is already taken. Try a different email.',
      unauthenticated: 'That email and password don’t match.',
    };
    if (byCode[r.code]) return byCode[r.code];
    if (r.code === 'validation_failed') return fallback || `Please check the details: ${r.message}`;
    return r.message || fallback || 'Something went wrong.';
  }

  // ---------- session and navigation ----------
  function setToken(t) { token = t; if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }
  function signOut() {
    setToken(null);
    me = null;
    for (const k of Object.keys(forms)) delete forms[k];
    go('/login', true);
  }
  function go(path, replace) {
    if (location.pathname !== path) history[replace ? 'replaceState' : 'pushState']({}, '', path);
    render();
  }
  window.addEventListener('popstate', render);
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[data-link]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    go(a.getAttribute('href'));
  });

  async function loadMe() {
    const data = await load('me', '/me');
    if (data) { me = data; paintWallets(); paintUser(); }
    return data;
  }

  // ---------- shell ----------
  const NAV = [['/', 'Wallet'], ['/requests', 'Requests'], ['/split', 'Split'], ['/authorizations', 'Holds']];
  let userSlot = null;
  function header(path) {
    userSlot = h('div', { class: 'user' });
    const nav = token ? h('nav', { class: 'nav', 'aria-label': 'Main' },
      NAV.map(([href, label]) => h('a', { href, 'data-link': true, class: 'nav-link', 'aria-current': path === href ? 'page' : null }, label)))
      : h('nav', { class: 'nav nav-auth', 'aria-label': 'Account' },
        h('a', { href: '/login', 'data-link': true, class: 'nav-link', 'aria-current': path === '/login' ? 'page' : null }, 'Log in'),
        h('a', { href: '/signup', 'data-link': true, class: 'nav-link', 'aria-current': path === '/signup' ? 'page' : null }, 'Sign up'));
    const bar = h('header', { class: 'topbar' }, h('div', { class: 'topbar-inner' },
      h('a', { href: token ? '/' : '/login', 'data-link': true, class: 'brand', 'aria-label': 'Pocketful home' },
        h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, 'P'), h('span', { class: 'brand-name' }, 'Pocketful')),
      token ? userSlot : null, nav));
    paintUser();
    return bar;
  }
  function paintUser() {
    if (!userSlot || !token) return;
    if (!me) { fill(userSlot, h('span', { class: 'skeleton skeleton-user' })); return; }
    fill(userSlot,
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, (me.display_name || me.handle).trim().charAt(0).toUpperCase() || '?'),
      h('span', { class: 'user-text' },
        h('span', { class: 'user-name', testid: 'current-user' }, me.display_name || me.handle),
        h('span', { class: 'user-handle' }, '@', h('span', { testid: 'current-handle' }, me.handle))),
      h('button', { type: 'button', class: 'btn btn-quiet btn-sm', testid: 'logout-button', onclick: () => signOut() }, 'Log out'));
  }

  // ---------- notices ----------
  function notice(kind, testid, text, extra) {
    const icon = { error: '!', uncertain: '?', success: '✓', info: 'i' }[kind];
    return h('div', { class: `notice notice-${kind}`, testid, role: kind === 'error' || kind === 'uncertain' ? 'alert' : 'status' },
      h('span', { class: 'notice-icon', 'aria-hidden': 'true' }, icon), h('div', { class: 'notice-body' }, text, extra || null));
  }
  function paintMsg(slot, f, prefix) {
    const m = f.msg;
    if (!m) return fill(slot);
    if (m.kind === 'error') return fill(slot, notice('error', `${prefix}-error`, m.text));
    if (m.kind === 'uncertain') return fill(slot, notice('uncertain', `${prefix}-uncertain`, m.text));
    return fill(slot, notice('success', null, m.text));
  }
  const UNCERTAIN = 'We couldn’t confirm whether this went through. Press the button again to check — it is safe and will never move the money twice.';

  // ---------- form fields ----------
  function input(f, name, attrs) {
    const extra = attrs.oninput;
    return h('input', { ...attrs, value: f.values[name], oninput: (e) => { f.values[name] = e.target.value; if (extra) extra(e); } });
  }
  function field(label, control, hint) {
    const id = 'f-' + Math.random().toString(36).slice(2, 9);
    control.id = id;
    return h('div', { class: 'field' }, h('label', { for: id, class: 'field-label' }, label), control, hint ? h('p', { class: 'field-hint' }, hint) : null);
  }
  function visibilitySelect(f, testid) {
    return h('select', { testid, value: f.values.visibility, onchange: (e) => { f.values.visibility = e.target.value; } },
      h('option', { value: 'public' }, 'Public'),
      h('option', { value: 'private' }, 'Private (only you and them)'));
  }
  const cleanHandle = (s) => s.trim().replace(/^@/, '');
  function submitButton(f, testid, label, busyLabel) {
    return h('button', { type: 'submit', class: 'btn btn-primary', testid, disabled: f.busy, 'aria-busy': f.busy ? 'true' : null }, f.busy ? busyLabel : label);
  }

  // ---------- wallet ----------
  const walletSlots = new Set();
  function walletCard(onRefresh) {
    const slot = h('section', { class: 'card wallet', 'aria-label': 'Your wallet' });
    slot._onRefresh = onRefresh;
    walletSlots.add(slot);
    paintWallet(slot);
    return slot;
  }
  function paintWallets() { for (const s of walletSlots) if (s.isConnected) paintWallet(s); else walletSlots.delete(s); }
  function paintWallet(slot) {
    if (!me) { fill(slot, h('div', { class: 'skeleton skeleton-amount' })); return; }
    const refresh = h('button', { type: 'button', class: 'btn btn-quiet btn-sm', testid: 'wallet-refresh',
      onclick: async (e) => {
        const b = e.currentTarget; b.classList.add('is-busy'); b.setAttribute('aria-busy', 'true');
        await slot._onRefresh();
        b.classList.remove('is-busy'); b.removeAttribute('aria-busy');
      } }, h('span', { class: 'spin', 'aria-hidden': 'true' }, '↻'), ' Refresh');
    fill(slot,
      h('div', { class: 'wallet-top' }, h('span', { class: 'eyebrow' }, 'Available to spend'), refresh),
      h('div', { class: 'wallet-available', testid: 'wallet-available', 'data-amount': me.available }, money(me.available)),
      h('dl', { class: 'wallet-meta' },
        h('div', { class: 'meta-item' }, h('dt', null, 'Total balance'),
          h('dd', { testid: 'wallet-balance', 'data-amount': me.balance }, money(me.balance))),
        me.held > 0 ? h('div', { class: 'meta-item meta-held' }, h('dt', null, h('span', { class: 'dot dot-held', 'aria-hidden': 'true' }), 'On hold'),
          h('dd', { testid: 'wallet-held', 'data-amount': me.held }, money(me.held))) : null));
  }

  // ---------- page: wallet "/" ----------
  let feedLimit = 50;
  function pageWallet(main) {
    document.title = 'Wallet · Pocketful';
    const feed = h('div', { class: 'feed-body' }, skeletonRows(3));
    const refreshBoth = () => Promise.all([loadMe(), loadFeed(feed)]);
    // Wallet grid: one column on phones (wallet, send, activity, request, hold); on desktop the
    // activity feed runs down the right-hand column beside the forms.
    fill(main,
      h('div', { class: 'grid grid-wallet' },
        h('div', { class: 'area-wallet' }, walletCard(refreshBoth)),
        h('div', { class: 'area-pay' }, payCard(refreshBoth)),
        h('div', { class: 'area-request' }, requestCard(refreshBoth)),
        h('div', { class: 'area-hold' }, authorizeCard(refreshBoth, 'compact')),
        h('section', { class: 'card feed area-feed', 'aria-labelledby': 'feed-title' },
          h('div', { class: 'card-head' }, h('h2', { id: 'feed-title' }, 'Activity'),
            h('span', { class: 'card-sub' }, 'Payments you can see — yours and public ones')),
          feed)));
    loadFeed(feed);
  }
  function skeletonRows(n) { return h('div', { class: 'skeleton-list', 'aria-label': 'Loading', role: 'status' }, Array.from({ length: n }, () => h('div', { class: 'skeleton skeleton-row' }))); }

  async function loadFeed(slot) {
    const data = await load('activity', `/activity?limit=${feedLimit}`);
    if (!data || !slot.isConnected) return;
    if (data.payments.length === 0) {
      fill(slot, h('div', { class: 'empty', testid: 'empty-activity' },
        h('div', { class: 'empty-art', 'aria-hidden': 'true' }, '☕'),
        h('p', { class: 'empty-title' }, 'No activity yet'),
        h('p', { class: 'empty-text' }, 'Payments you send or receive, and public payments, will show up here.')));
      return;
    }
    const list = h('ul', { class: 'list', testid: 'activity-list' }, data.payments.map(feedItem));
    const more = data.has_more && feedLimit < 200
      ? h('button', { type: 'button', class: 'btn btn-quiet btn-block', onclick: () => { feedLimit = Math.min(200, feedLimit + 50); loadFeed(slot); } }, 'Show older activity')
      : null;
    fill(slot, list, more);
  }
  function feedItem(p) {
    const mine = me && p.from_user_id === me.user_id, toMe = me && p.to_user_id === me.user_id;
    const title = mine ? ['You paid ', h('b', null, '@' + p.to_handle)] : toMe ? [h('b', null, '@' + p.from_handle), ' paid you'] : [h('b', null, '@' + p.from_handle), ' paid ', h('b', null, '@' + p.to_handle)];
    const dir = mine ? 'out' : toMe ? 'in' : 'other';
    const tags = [];
    if (p.visibility === 'private') tags.push(h('span', { class: 'chip chip-private' }, h('span', { 'aria-hidden': 'true' }, '🔒 '), 'Private'));
    if (p.request_id) tags.push(h('span', { class: 'chip' }, 'Request'));
    if (p.settlement_id) tags.push(h('span', { class: 'chip' }, 'Settlement'));
    if (p.authorization_id) tags.push(h('span', { class: 'chip chip-held-soft' }, 'From a hold'));
    return h('li', { class: `item item-${dir}`, testid: `activity-item-${p.payment_id}`, 'data-visibility': p.visibility },
      h('span', { class: `item-icon icon-${dir}`, 'aria-hidden': 'true' }, dir === 'out' ? '↑' : dir === 'in' ? '↓' : '⇄'),
      h('div', { class: 'item-main' },
        h('div', { class: 'item-title' }, title),
        h('div', { class: 'item-sub' },
          h('span', { class: 'parties', testid: `activity-parties-${p.payment_id}` }, `@${p.from_handle} → @${p.to_handle}`),
          h('span', { class: 'sep', 'aria-hidden': 'true' }, '·'), timeEl(p.created_at)),
        h('div', { class: 'item-note', testid: `activity-note-${p.payment_id}` }, p.note),
        tags.length ? h('div', { class: 'tags' }, tags) : null),
      h('div', { class: 'item-side' },
        h('span', { class: 'sr-only' }, mine ? 'Sent' : toMe ? 'Received' : 'Transferred'),
        h('span', { class: `amount amount-${dir}`, testid: `activity-amount-${p.payment_id}` }, money(p.amount))));
  }

  function payCard(after) {
    const f = formState('pay', { handle: '', amount: '', note: '', visibility: 'public' });
    const msg = h('div', { class: 'msg-slot', 'aria-live': 'polite' });
    const card = h('section', { class: 'card', 'aria-labelledby': 'pay-title' });
    const draw = () => {
      fill(card,
        h('div', { class: 'card-head' }, h('h2', { id: 'pay-title' }, 'Send money'), h('span', { class: 'card-sub' }, 'Moves instantly from your available funds')),
        h('form', { class: 'form', novalidate: true, onsubmit: submit },
          h('div', { class: 'row-2' },
            field('To (handle)', input(f, 'handle', { testid: 'pay-handle', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: '@handle' })),
            field(`Amount (${cur()})`, input(f, 'amount', { testid: 'pay-amount', inputmode: 'decimal', autocomplete: 'off', placeholder: decimal(0) }))),
          field('Note (optional)', input(f, 'note', { testid: 'pay-note', maxlength: '200', placeholder: 'Dinner, rent, gift…' })),
          field('Who can see it', visibilitySelect(f, 'pay-visibility')),
          msg,
          h('div', { class: 'actions' }, submitButton(f, 'pay-submit', 'Send money', 'Sending…'))));
      paintMsg(msg, f, 'pay');
    };
    async function submit(e) {
      e.preventDefault();
      if (f.busy) return;
      const handle = cleanHandle(f.values.handle);
      const amt = parseAmount(f.values.amount);
      if (!handle) { f.msg = { kind: 'error', text: 'Enter the handle of the person you’re paying.' }; return draw(); }
      if (amt.error) { f.msg = { kind: 'error', text: amt.error }; return draw(); }
      const body = { to_handle: handle, amount: amt.minor, note: f.values.note, visibility: f.values.visibility };
      f.busy = true; f.msg = null; draw();
      const r = await idemSend(f, '/payments', body);
      f.busy = false;
      if (r.kind === 'unauth') return;
      if (r.kind === 'ok') {
        f.msg = { kind: 'success', text: r.status === 200 ? `Confirmed: ${money(r.data.amount)} to @${r.data.to_handle} went through once — nothing was sent twice.` : `Sent ${money(r.data.amount)} to @${r.data.to_handle}.` };
      } else if (r.kind === 'refused') {
        f.msg = { kind: 'error', text: explain(r) };
      } else {
        f.msg = { kind: 'uncertain', text: UNCERTAIN };
      }
      draw();
      if (card.isConnected) await after();
    }
    draw();
    return card;
  }

  function requestCard(after) {
    const f = formState('request', { handle: '', amount: '', note: '' });
    const msg = h('div', { class: 'msg-slot', 'aria-live': 'polite' });
    const card = h('section', { class: 'card', 'aria-labelledby': 'req-title' });
    const draw = () => {
      fill(card,
        h('div', { class: 'card-head' }, h('h2', { id: 'req-title' }, 'Request money'), h('span', { class: 'card-sub' }, 'They can pay, or decline, from their Requests')),
        h('form', { class: 'form', novalidate: true, onsubmit: submit },
          h('div', { class: 'row-2' },
            field('From (handle)', input(f, 'handle', { testid: 'request-handle', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: '@handle' })),
            field(`Amount (${cur()})`, input(f, 'amount', { testid: 'request-amount', inputmode: 'decimal', autocomplete: 'off', placeholder: decimal(0) }))),
          field('Note (optional)', input(f, 'note', { testid: 'request-note', maxlength: '200', placeholder: 'Taxi home' })),
          msg,
          h('div', { class: 'actions' }, submitButton(f, 'request-submit', 'Send request', 'Sending…'))));
      paintMsg(msg, f, 'request');
    };
    async function submit(e) {
      e.preventDefault();
      if (f.busy) return;
      const handle = cleanHandle(f.values.handle);
      const amt = parseAmount(f.values.amount);
      if (!handle) { f.msg = { kind: 'error', text: 'Enter the handle of the person you’re asking.' }; return draw(); }
      if (amt.error) { f.msg = { kind: 'error', text: amt.error }; return draw(); }
      const body = { payer_handle: handle, amount: amt.minor, note: f.values.note };
      f.busy = true; f.msg = null; draw();
      const r = await idemSend(f, '/requests', body);
      f.busy = false;
      if (r.kind === 'unauth') return;
      if (r.kind === 'ok') f.msg = { kind: 'success', text: `Requested ${money(r.data.amount)} from @${r.data.payer_handle}.` };
      else if (r.kind === 'refused') f.msg = { kind: 'error', text: explain(r) };
      else f.msg = { kind: 'uncertain', text: UNCERTAIN };
      draw();
      if (card.isConnected) await after();
    }
    draw();
    return card;
  }

  function authorizeCard(after, variant) {
    const f = formState('authorize', { handle: '', amount: '', note: '', visibility: 'public' });
    const msg = h('div', { class: 'msg-slot', 'aria-live': 'polite' });
    const card = h('section', { class: 'card', 'aria-labelledby': 'auth-title-' + variant });
    const draw = () => {
      fill(card,
        h('div', { class: 'card-head' }, h('h2', { id: 'auth-title-' + variant }, 'Put money on hold'),
          h('span', { class: 'card-sub' }, 'Reserve funds now; they collect it later, all at once or in parts')),
        h('form', { class: 'form', novalidate: true, onsubmit: submit },
          h('div', { class: 'row-2' },
            field('For (handle)', input(f, 'handle', { testid: 'authorize-handle', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: '@handle' })),
            field(`Amount (${cur()})`, input(f, 'amount', { testid: 'authorize-amount', inputmode: 'decimal', autocomplete: 'off', placeholder: decimal(0) }))),
          field('Note (optional)', input(f, 'note', { testid: 'authorize-note', maxlength: '200', placeholder: 'Deposit' })),
          field('Who can see the payment', visibilitySelect(f, 'authorize-visibility')),
          msg,
          h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'btn btn-secondary', testid: 'authorize-submit', disabled: f.busy, 'aria-busy': f.busy ? 'true' : null }, f.busy ? 'Placing hold…' : 'Place hold'))));
      paintMsg(msg, f, 'authorize');
    };
    async function submit(e) {
      e.preventDefault();
      if (f.busy) return;
      const handle = cleanHandle(f.values.handle);
      const amt = parseAmount(f.values.amount);
      if (!handle) { f.msg = { kind: 'error', text: 'Enter the handle of the person you’re holding funds for.' }; return draw(); }
      if (amt.error) { f.msg = { kind: 'error', text: amt.error }; return draw(); }
      const body = { to_handle: handle, amount: amt.minor, note: f.values.note, visibility: f.values.visibility };
      f.busy = true; f.msg = null; draw();
      const r = await idemSend(f, '/authorizations', body);
      f.busy = false;
      if (r.kind === 'unauth') return;
      if (r.kind === 'ok') f.msg = { kind: 'success', text: `${money(r.data.amount)} is on hold for @${r.data.to_handle} until ${when(r.data.expires_at)}.` };
      else if (r.kind === 'refused') f.msg = { kind: 'error', text: explain(r) };
      else f.msg = { kind: 'uncertain', text: UNCERTAIN };
      draw();
      if (card.isConnected) await after();
    }
    draw();
    return card;
  }

  // ---------- page: requests ----------
  const reqUi = { msg: null };
  function pageRequests(main) {
    document.title = 'Requests · Pocketful';
    const banner = h('div', { class: 'msg-slot', 'aria-live': 'polite' });
    const incoming = h('ul', { class: 'list', testid: 'incoming-list', 'aria-label': 'Requests waiting on you' });
    const outgoing = h('ul', { class: 'list', testid: 'outgoing-list', 'aria-label': 'Requests you sent' });
    const emptySlot = h('div');
    const inBody = h('div', null, skeletonRows(2));
    const outBody = h('div', null, skeletonRows(2));
    reqUi.msg = null;
    const ctx = { banner, incoming, outgoing, emptySlot, inBody, outBody };
    fill(main,
      h('div', { class: 'page-head' }, h('h1', null, 'Requests'), h('p', { class: 'page-sub' }, 'Money people asked you for, and money you asked for.')),
      banner, emptySlot,
      h('div', { class: 'grid grid-even' },
        h('section', { class: 'card', 'aria-labelledby': 'in-title' },
          h('div', { class: 'card-head' }, h('h2', { id: 'in-title' }, 'Waiting on you'), h('span', { class: 'card-sub' }, 'Pay or decline')), inBody, incoming),
        h('section', { class: 'card', 'aria-labelledby': 'out-title' },
          h('div', { class: 'card-head' }, h('h2', { id: 'out-title' }, 'You asked'), h('span', { class: 'card-sub' }, 'Cancel any that are still pending')), outBody, outgoing)));
    paintReqBanner(ctx);
    loadRequests(ctx);
  }
  function paintReqBanner(ctx) {
    const m = reqUi.msg;
    if (!m) return fill(ctx.banner);
    fill(ctx.banner, notice(m.kind, m.kind === 'error' ? 'request-error' : m.kind === 'uncertain' ? 'request-uncertain' : null, m.text));
  }
  async function loadRequests(ctx) {
    const data = await load('requests', '/requests?limit=200');
    if (!data || !ctx.incoming.isConnected) return;
    const inc = data.requests.filter((r) => r.payer_id === me.user_id);
    const out = data.requests.filter((r) => r.requester_id === me.user_id);
    fill(ctx.inBody, inc.length ? null : h('p', { class: 'list-empty' }, 'Nobody is waiting on you.'));
    fill(ctx.outBody, out.length ? null : h('p', { class: 'list-empty' }, 'You haven’t asked anyone for money.'));
    fill(ctx.incoming, inc.map((r) => requestItem(r, true, ctx)));
    fill(ctx.outgoing, out.map((r) => requestItem(r, false, ctx)));
    fill(ctx.emptySlot, inc.length || out.length ? null : h('div', { class: 'empty empty-wide', testid: 'empty-requests' },
      h('div', { class: 'empty-art', 'aria-hidden': 'true' }, '✉'),
      h('p', { class: 'empty-title' }, 'No requests yet'),
      h('p', { class: 'empty-text' }, 'Ask someone for money from your wallet, or split a bill.'),
      h('a', { href: '/split', 'data-link': true, class: 'btn btn-quiet btn-sm' }, 'Split a bill')));
  }
  const STATUS_LABEL = { pending: 'Pending', paid: 'Paid', declined: 'Declined', cancelled: 'Cancelled', open: 'On hold', captured: 'Collected', voided: 'Released', expired: 'Expired' };
  const statusChip = (s) => h('span', { class: `chip status status-${s}` }, STATUS_LABEL[s] || s);
  const reqVis = {};
  function requestItem(r, incoming, ctx) {
    const id = r.request_id;
    const actions = [];
    const busy = (b) => { for (const el of actions) if (el.tagName === 'BUTTON') el.disabled = b; };
    const act = async (fn) => {
      busy(true);
      const res = await fn();
      if (res.kind === 'unauth') return;
      if (res.kind === 'ok') reqUi.msg = null;
      else if (res.kind === 'refused') reqUi.msg = { kind: 'error', text: explain(res) };
      else reqUi.msg = { kind: 'uncertain', text: UNCERTAIN };
      if (!ctx.incoming.isConnected) return;
      paintReqBanner(ctx);
      await Promise.all([loadRequests(ctx), loadMe()]);
    };
    if (r.status === 'pending' && incoming) {
      const vis = h('select', { class: 'select-sm', 'aria-label': 'Who can see this payment', value: reqVis[id] || 'public', onchange: (e) => { reqVis[id] = e.target.value; } },
        h('option', { value: 'public' }, 'Public'), h('option', { value: 'private' }, 'Private'));
      actions.push(vis,
        h('button', { type: 'button', class: 'btn btn-primary btn-sm', testid: `request-pay-${id}`,
          onclick: () => act(() => idemSend(formState('reqpay:' + id, {}), `/requests/${encodeURIComponent(id)}/pay`, { visibility: reqVis[id] || 'public' })) }, 'Pay'),
        h('button', { type: 'button', class: 'btn btn-quiet btn-sm', testid: `request-decline-${id}`,
          onclick: () => act(() => api('POST', `/requests/${encodeURIComponent(id)}/decline`)) }, 'Decline'));
    }
    if (r.status === 'pending' && !incoming) {
      actions.push(h('button', { type: 'button', class: 'btn btn-quiet btn-sm', testid: `request-cancel-${id}`,
        onclick: () => act(() => api('POST', `/requests/${encodeURIComponent(id)}/cancel`)) }, 'Cancel request'));
    }
    return h('li', { class: `item item-req status-row-${r.status}`, testid: `request-item-${id}`, 'data-status': r.status },
      h('span', { class: `item-icon icon-${incoming ? 'out' : 'in'}`, 'aria-hidden': 'true' }, incoming ? '↑' : '↓'),
      h('div', { class: 'item-main' },
        h('div', { class: 'item-title' }, incoming ? [h('b', null, '@' + r.requester_handle), ' asked you'] : ['You asked ', h('b', null, '@' + r.payer_handle)]),
        h('div', { class: 'item-sub' }, statusChip(r.status), h('span', { class: 'sep', 'aria-hidden': 'true' }, '·'), timeEl(r.created_at)),
        r.note ? h('div', { class: 'item-note' }, r.note) : null,
        actions.length ? h('div', { class: 'item-actions' }, actions) : null),
      h('div', { class: 'item-side' }, h('span', { class: `amount ${r.status === 'pending' ? 'amount-pending' : 'amount-muted'}`, testid: `request-amount-${id}` }, money(r.amount))));
  }

  // ---------- page: split ----------
  function pageSplit(main) {
    document.title = 'Split a bill · Pocketful';
    const f = formState('split', { amount: '', handles: '', note: '' });
    const preview = h('div', { class: 'preview-slot', 'aria-live': 'polite' });
    const msg = h('div', { class: 'msg-slot', 'aria-live': 'polite' });
    const result = h('div');
    const handlesOf = () => f.values.handles.split(',').map(cleanHandle).filter(Boolean);
    const paintPreview = () => {
      const amt = parseAmount(f.values.amount);
      const hs = handlesOf();
      if (amt.error || hs.length === 0) {
        return fill(preview, h('p', { class: 'preview-hint' }, 'Enter an amount and the people to split with to see each share before anything is sent.'));
      }
      if (new Set(hs).size !== hs.length) return fill(preview, h('p', { class: 'preview-hint preview-warn' }, 'Each person can appear only once.'));
      const shares = shareSplit(amt.minor, hs.length);
      fill(preview, h('div', { class: 'preview', testid: 'split-preview' },
        h('div', { class: 'preview-head' }, h('span', null, 'Each share'), h('span', { class: 'preview-total' }, `${hs.length} ${hs.length === 1 ? 'person' : 'people'} · ${money(amt.minor)}`)),
        h('ul', { class: 'shares' }, hs.map((hd, i) => h('li', { class: 'share' },
          h('span', { class: 'share-who' }, '@' + hd, me && hd === me.handle ? h('span', { class: 'chip chip-you' }, 'You') : null),
          h('span', { class: 'share-amt', testid: `split-share-${hd}` }, money(shares[i])))))));
    };
    const draw = () => {
      fill(main,
        h('div', { class: 'page-head' }, h('h1', null, 'Split a bill'), h('p', { class: 'page-sub' }, 'You paid; everyone else gets a request for their equal share.')),
        h('div', { class: 'grid' },
          h('section', { class: 'card', 'aria-labelledby': 'split-title' },
            h('div', { class: 'card-head' }, h('h2', { id: 'split-title' }, 'Bill details')),
            h('form', { class: 'form', novalidate: true, onsubmit: submit },
              field(`Total amount (${cur()})`, input(f, 'amount', { testid: 'split-amount', inputmode: 'decimal', autocomplete: 'off', placeholder: decimal(0), oninput: () => setTimeout(paintPreview) })),
              field('Split between (handles, separated by commas)', input(f, 'handles', { testid: 'split-handles', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: `${me ? me.handle : 'you'}, friend, another_friend`, oninput: () => setTimeout(paintPreview) }),
                'Include yourself if you’re sharing the cost. Uneven cents go to the first people listed.'),
              field('Note (optional)', input(f, 'note', { testid: 'split-note', maxlength: '200', placeholder: 'Dinner at Luigi’s' })),
              msg,
              h('div', { class: 'actions' }, submitButton(f, 'split-submit', 'Send split requests', 'Sending…')))),
          h('section', { class: 'card', 'aria-label': 'Preview' }, h('div', { class: 'card-head' }, h('h2', null, 'Preview')), preview, result)));
      paintMsg(msg, f, 'split');
      paintPreview();
      if (f.result) paintResult();
    };
    const paintResult = () => {
      const s = f.result;
      fill(result, h('div', { class: 'result' }, h('p', { class: 'result-title' }, s.requests.length ? `Requests sent to ${s.requests.length} ${s.requests.length === 1 ? 'person' : 'people'}` : 'Nothing to request — you’re the only participant'),
        h('ul', { class: 'result-list' }, s.requests.map((r) => h('li', null, `@${r.payer_handle}`, h('span', null, money(r.amount)))))));
    };
    async function submit(e) {
      e.preventDefault();
      if (f.busy) return;
      const amt = parseAmount(f.values.amount);
      const hs = handlesOf();
      if (amt.error) { f.msg = { kind: 'error', text: amt.error }; return draw(); }
      if (hs.length === 0) { f.msg = { kind: 'error', text: 'Add at least one handle.' }; return draw(); }
      if (new Set(hs).size !== hs.length) { f.msg = { kind: 'error', text: 'Each person can appear only once.' }; return draw(); }
      const body = { amount: amt.minor, participant_handles: hs, note: f.values.note };
      f.busy = true; f.msg = null; f.result = null; draw();
      const r = await idemSend(f, '/splits', body);
      f.busy = false;
      if (r.kind === 'unauth') return;
      if (r.kind === 'ok') { f.msg = { kind: 'success', text: `Split of ${money(r.data.amount)} created.` }; f.result = r.data; }
      else if (r.kind === 'refused') f.msg = { kind: 'error', text: explain(r) };
      else f.msg = { kind: 'uncertain', text: UNCERTAIN };
      if (main.isConnected && location.pathname === '/split') draw();
      loadMe();
    }
    draw();
  }

  // ---------- page: authorizations ----------
  const authUi = { msg: null, capture: {} };
  function pageAuthorizations(main) {
    document.title = 'Holds · Pocketful';
    const banner = h('div', { class: 'msg-slot', 'aria-live': 'polite' });
    const body = h('div', null, skeletonRows(2));
    authUi.msg = null;
    const ctx = { banner, body };
    const refreshAll = () => Promise.all([loadMe(), loadAuths(ctx)]);
    ctx.refreshAll = refreshAll;
    fill(main,
      h('div', { class: 'page-head' }, h('h1', null, 'Holds'), h('p', { class: 'page-sub' }, 'Money reserved for someone to collect later. Held funds can’t be spent until released.')),
      h('div', { class: 'grid' },
        h('div', { class: 'col' }, walletCard(refreshAll), authorizeCard(refreshAll, 'full')),
        h('section', { class: 'card', 'aria-labelledby': 'holds-title' },
          h('div', { class: 'card-head' }, h('h2', { id: 'holds-title' }, 'Your holds'), h('span', { class: 'card-sub' }, 'Holds you placed and holds placed for you')),
          banner, body)));
    paintAuthBanner(ctx);
    loadAuths(ctx);
  }
  function paintAuthBanner(ctx) {
    const m = authUi.msg;
    if (!m) return fill(ctx.banner);
    fill(ctx.banner, notice(m.kind, m.kind === 'error' ? 'authorization-error' : m.kind === 'uncertain' ? 'authorization-uncertain' : null, m.text));
  }
  async function loadAuths(ctx) {
    const data = await load('auths', '/authorizations?limit=200');
    if (!data || !ctx.body.isConnected) return;
    if (data.authorizations.length === 0) {
      fill(ctx.body, h('div', { class: 'empty', testid: 'empty-authorizations' },
        h('div', { class: 'empty-art', 'aria-hidden': 'true' }, '⏳'),
        h('p', { class: 'empty-title' }, 'No holds'),
        h('p', { class: 'empty-text' }, 'When you reserve money for someone, or someone reserves money for you, it appears here.')));
      return;
    }
    fill(ctx.body, h('ul', { class: 'list', testid: 'authorization-list' }, data.authorizations.map((a) => authItem(a, ctx))));
  }
  function authItem(a, ctx) {
    const id = a.authorization_id;
    const outgoing = me && a.from_user_id === me.user_id;
    const open = a.status === 'open';
    const actions = [];
    const act = async (fn) => {
      for (const el of actions) el.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      const res = await fn();
      if (!res) return;
      if (res.kind === 'unauth') return;
      // A capture answers with a payment (no status field); a void answers with the authorisation.
      if (res.kind === 'ok') authUi.msg = { kind: 'success', text: res.data.status === undefined ? `Collected ${money(res.data.amount)} from @${res.data.from_handle}.` : 'Hold released. The money is available again.' };
      else if (res.kind === 'refused') authUi.msg = { kind: 'error', text: explain(res) };
      else authUi.msg = { kind: 'uncertain', text: UNCERTAIN };
      if (!ctx.body.isConnected) return;
      paintAuthBanner(ctx);
      await ctx.refreshAll();
    };
    if (open && !outgoing) {
      const st = authUi.capture[id] && authUi.capture[id].remaining === a.remaining_amount ? authUi.capture[id]
        : (authUi.capture[id] = { remaining: a.remaining_amount, value: decimal(a.remaining_amount), keep: false });
      const amountInput = h('input', { testid: `authorization-capture-amount-${id}`, inputmode: 'decimal', autocomplete: 'off', value: st.value, oninput: (e) => { st.value = e.target.value; } });
      const keep = h('input', { type: 'checkbox', checked: st.keep, onchange: (e) => { st.keep = e.target.checked; } });
      const capBtn = h('button', { type: 'button', class: 'btn btn-primary btn-sm', testid: `authorization-capture-${id}`,
        onclick: () => act(async () => {
          const amt = parseAmount(st.value);
          if (amt.error) { authUi.msg = { kind: 'error', text: amt.error }; paintAuthBanner(ctx); capBtn.disabled = false; return null; }
          const body = st.keep ? { amount: amt.minor, final: false } : { amount: amt.minor };
          return idemSend(formState('cap:' + id, {}), `/authorizations/${encodeURIComponent(id)}/capture`, body);
        }) }, 'Collect');
      actions.push(h('div', { class: 'capture' },
        field(`Amount to collect (${cur()})`, amountInput),
        h('label', { class: 'check' }, keep, h('span', null, 'Keep the rest on hold')),
        capBtn));
    }
    if (open && outgoing) {
      actions.push(h('div', null, h('button', { type: 'button', class: 'btn btn-quiet btn-sm', testid: `authorization-void-${id}`,
        onclick: () => act(() => api('POST', `/authorizations/${encodeURIComponent(id)}/void`)) }, 'Release hold')));
    }
    const facts = [];
    if (a.status === 'captured') facts.push(h('span', null, 'Collected ', h('b', { testid: `authorization-captured-${id}` }, money(a.captured_amount))));
    else if (a.captured_amount > 0) facts.push(h('span', null, 'Collected so far ', h('b', null, money(a.captured_amount))));
    if (open) facts.push(h('span', { class: 'held-text' }, 'Still held ', h('b', null, money(a.remaining_amount))));
    return h('li', { class: `item item-hold status-row-${a.status}`, testid: `authorization-item-${id}`, 'data-status': a.status },
      h('span', { class: `item-icon icon-${open ? 'held' : outgoing ? 'out' : 'in'}`, 'aria-hidden': 'true' }, open ? '⏸' : outgoing ? '↑' : '↓'),
      h('div', { class: 'item-main' },
        h('div', { class: 'item-title' }, outgoing ? ['Held for ', h('b', null, '@' + a.to_handle)] : [h('b', null, '@' + a.from_handle), ' is holding for you']),
        h('div', { class: 'item-sub' }, statusChip(a.status),
          a.visibility === 'private' ? h('span', { class: 'chip chip-private' }, '🔒 Private') : null,
          h('span', { class: 'sep', 'aria-hidden': 'true' }, '·'),
          h('span', null, a.status === 'open' ? 'Expires ' : 'Expiry ', h('time', { class: 'mono', datetime: a.expires_at, testid: `authorization-expires-${id}` }, a.expires_at),
            a.status === 'open' ? h('span', { class: 'muted' }, ` (${relative(a.expires_at)})`) : null)),
        a.note ? h('div', { class: 'item-note' }, a.note) : null,
        facts.length ? h('div', { class: 'facts' }, facts) : null,
        actions.length ? h('div', { class: 'item-actions' }, actions) : null),
      h('div', { class: 'item-side' }, h('span', { class: `amount ${open ? 'amount-held' : 'amount-muted'}`, testid: `authorization-amount-${id}` }, money(a.amount))));
  }

  // ---------- pages: login / signup ----------
  const authForms = { login: { values: { email: '', password: '' }, error: null, busy: false }, signup: { values: { email: '', password: '', display_name: '' }, error: null, busy: false } };
  function pageAuth(main, kind) {
    const isLogin = kind === 'login';
    document.title = (isLogin ? 'Log in' : 'Create account') + ' · Pocketful';
    const f = authForms[kind];
    f.error = null;
    const p = isLogin ? 'login' : 'signup';
    const draw = () => {
      fill(main, h('div', { class: 'auth-wrap' }, h('section', { class: 'card auth-card', 'aria-labelledby': 'auth-title' },
        h('h1', { id: 'auth-title' }, isLogin ? 'Welcome back' : 'Create your Pocketful'),
        h('p', { class: 'page-sub' }, isLogin ? 'Log in to send, request and split money.' : 'Send money by handle, split bills, and see where it all went.'),
        h('form', { class: 'form', novalidate: true, onsubmit: submit },
          isLogin ? null : field('Your name', input(f, 'display_name', { testid: 'signup-display-name', autocomplete: 'name', placeholder: 'Ada Lovelace' })),
          field('Email', input(f, 'email', { testid: `${p}-email`, type: 'email', autocomplete: 'email', autocapitalize: 'none', placeholder: 'you@example.com' }),
            isLogin ? null : 'Your handle is made from the part before the @.'),
          field('Password', input(f, 'password', { testid: `${p}-password`, type: 'password', autocomplete: isLogin ? 'current-password' : 'new-password' }),
            isLogin ? null : 'At least 8 characters.'),
          f.error ? notice('error', 'auth-error', f.error) : null,
          h('button', { type: 'submit', class: 'btn btn-primary btn-block', testid: `${p}-submit`, disabled: f.busy }, f.busy ? (isLogin ? 'Logging in…' : 'Creating account…') : (isLogin ? 'Log in' : 'Create account'))),
        h('p', { class: 'auth-switch' }, isLogin ? 'New to Pocketful? ' : 'Already have an account? ',
          h('a', { href: isLogin ? '/signup' : '/login', 'data-link': true }, isLogin ? 'Create an account' : 'Log in')))));
    };
    async function submit(e) {
      e.preventDefault();
      if (f.busy) return;
      const body = isLogin ? { email: f.values.email.trim(), password: f.values.password }
        : { email: f.values.email.trim(), password: f.values.password, display_name: f.values.display_name };
      if (!body.email || !body.password) { f.error = 'Enter your email and password.'; return draw(); }
      f.busy = true; f.error = null; draw();
      const r = await api('POST', isLogin ? '/auth/login' : '/auth/signup', { body, auth: false });
      f.busy = false;
      if (r.kind === 'ok') {
        setToken(r.data.token);
        me = null;
        for (const k of Object.keys(forms)) delete forms[k];
        f.values.password = '';
        go('/');
        return;
      }
      f.error = r.kind === 'refused' ? (r.status === 401 ? 'That email and password don’t match.' : explain(r)) : 'We couldn’t reach Pocketful. Check your connection and try again.';
      draw();
    }
    draw();
  }

  function pageNotFound(main) {
    document.title = 'Not found · Pocketful';
    fill(main, h('div', { class: 'empty empty-wide' }, h('p', { class: 'empty-title' }, 'This page doesn’t exist'),
      h('a', { href: '/', 'data-link': true, class: 'btn btn-primary btn-sm' }, 'Go to your wallet')));
  }

  // ---------- render ----------
  async function render() {
    const id = ++renderCounter;
    const path = location.pathname.replace(/\/+$/, '') || '/';
    if (PROTECTED.includes(path) && !token) { history.replaceState({}, '', '/login'); return render(); }
    walletSlots.clear();
    const main = h('main', { class: 'main', id: 'main' });
    fill(root, h('a', { href: '#main', class: 'skip' }, 'Skip to content'), header(path), main);
    if (token && !me) {
      if (PROTECTED.includes(path)) fill(main, h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading your wallet…'));
      if (PROTECTED.includes(path) || !PUBLIC.includes(path)) {
        await loadMe();
        if (id !== renderCounter) return;
        if (!token) return;
        if (!me) {
          fill(main, notice('uncertain', null, 'We couldn’t load your wallet. ', h('button', { type: 'button', class: 'btn btn-quiet btn-sm', onclick: () => render() }, 'Try again')));
          return;
        }
      } else {
        loadMe();
      }
    } else if (token && PROTECTED.includes(path)) {
      loadMe();
    }
    if (path === '/') pageWallet(main);
    else if (path === '/requests') pageRequests(main);
    else if (path === '/split') pageSplit(main);
    else if (path === '/authorizations') pageAuthorizations(main);
    else if (path === '/login') pageAuth(main, 'login');
    else if (path === '/signup') pageAuth(main, 'signup');
    else pageNotFound(main);
  }

  render();
})();
