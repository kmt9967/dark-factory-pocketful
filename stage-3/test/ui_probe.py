"""Browser probes for the stage-2 UI (W2b).

Run with the harness venv (it has Playwright + Chromium):
  BASE=http://127.0.0.1:P S1BASE=http://127.0.0.1:Q SHOTS=<dir> \
    <venv>/python stage-2/test/ui_probe.py
BASE is a stage-2 service, S1BASE a stage-1 service (upgrade probe); SHOTS receives screenshots.
"""
import asyncio
import json
import os
import sys
import time
import urllib.request
import uuid

from playwright.async_api import async_playwright, expect

BASE = os.environ.get("BASE", "http://127.0.0.1:18555")
S1BASE = os.environ.get("S1BASE")
SHOTS = os.environ.get("SHOTS")

PW = "correct horse"


def user(h, bal, **kw):
    return {"id": f"u_{h}", "email": f"{h}@example.com", "password": PW, "display_name": h.title(),
            "handle": h, "balance": bal, **kw}


def fixture(currency="EUR", mu=2, **kw):
    return {"currency": currency, "minor_units": mu, "users": [user("ada", 10000), user("bob", 2500), user("cy", 500)], **kw}


def http(method, url, body=None, token=None, key=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/json")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if key:
        req.add_header("Idempotency-Key", key)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        return e.code, (json.loads(raw) if raw else None)


def reset(fx, base=BASE):
    s, b = http("POST", f"{base}/_test/reset", fx)
    assert s == 204, (s, b)


def token_of(email, base=BASE):
    s, b = http("POST", f"{base}/auth/login", {"email": email, "password": PW})
    assert s == 200, (s, b)
    return b["token"]


def sel(t):
    return f"[data-testid='{t}']"


async def log_in(page, email="ada@example.com"):
    await page.goto("/login")
    await page.fill(sel("login-email"), email)
    await page.fill(sel("login-password"), PW)
    await page.click(sel("login-submit"))
    await page.wait_for_selector(sel("current-user"))


async def amount_attr(page, tid="wallet-balance"):
    return await page.get_attribute(sel(tid), "data-amount")


RESULTS = []


def probe(fn):
    RESULTS.append(fn)
    return fn


# ---------------------------------------------------------------- layout / a11y

@probe
async def no_horizontal_scroll_and_labels(browser):
    reset(fixture(authorizations=[{"id": "a_seed", "from_user_id": "u_ada", "to_user_id": "u_bob", "amount": 2000,
                                   "note": "deposit", "status": "open",
                                   "expires_at": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(time.time() + 7200))}]))
    bob = token_of("bob@example.com")
    http("POST", f"{BASE}/requests", {"payer_handle": "ada", "amount": 1200, "note": "taxi"}, bob, str(uuid.uuid4()))
    http("POST", f"{BASE}/payments", {"to_handle": "ada", "amount": 250, "note": "coffee ☕", "visibility": "private"}, bob, str(uuid.uuid4()))
    for width, height in ((375, 812), (1280, 900)):
        ctx = await browser.new_context(base_url=BASE, viewport={"width": width, "height": height})
        page = await ctx.new_page()
        await page.goto("/login")
        await page.wait_for_selector(sel("login-submit"))
        if SHOTS:
            await page.screenshot(path=os.path.join(SHOTS, f"login-{width}.png"), full_page=True)
        await log_in(page)
        for route, anchor in (("/", "activity-list"), ("/requests", "incoming-list"), ("/split", "split-submit"),
                              ("/authorizations", "authorization-list"), ("/signup", "signup-submit")):
            await page.goto(route)
            await page.wait_for_selector(sel(anchor), state="attached")
            if route == "/split":
                await page.fill(sel("split-amount"), "10.00")
                await page.fill(sel("split-handles"), "ada, bob, cy")
                await page.wait_for_selector(sel("split-preview"))
            await page.wait_for_timeout(150)
            sw, cw = await page.evaluate("[document.documentElement.scrollWidth, document.documentElement.clientWidth]")
            assert sw <= cw, f"{route} at {width}px scrolls horizontally: {sw} > {cw}"
            unlabeled = await page.evaluate("""() => [...document.querySelectorAll('input, select')]
                .filter(e => !(e.labels && e.labels.length) && !e.getAttribute('aria-label')).map(e => e.dataset.testid || e.outerHTML.slice(0, 60))""")
            assert not unlabeled, f"{route}: inputs without labels {unlabeled}"
            if SHOTS:
                name = route.strip("/") or "wallet"
                await page.screenshot(path=os.path.join(SHOTS, f"{name}-{width}.png"), full_page=True)
        # signed in: current-user/handle on every screen
        for route in ("/", "/requests", "/split", "/authorizations"):
            await page.goto(route)
            await page.wait_for_selector(sel("current-user"))
            assert (await page.text_content(sel("current-handle"))).strip() == "ada"
        await ctx.close()


@probe
async def wallet_numbers_and_holds(browser):
    reset(fixture(authorizations=[{"id": "a_seed", "from_user_id": "u_ada", "to_user_id": "u_bob", "amount": 2000,
                                   "status": "open",
                                   "expires_at": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(time.time() + 7200))}]))
    ctx = await browser.new_context(base_url=BASE)
    page = await ctx.new_page()
    await log_in(page)
    await page.goto("/")
    await page.wait_for_selector(sel("wallet-available"))
    assert await amount_attr(page, "wallet-available") == "8000"
    assert (await page.text_content(sel("wallet-available"))).strip() == "80.00 EUR"
    assert await amount_attr(page, "wallet-balance") == "10000"
    assert (await page.text_content(sel("wallet-held"))).strip() == "20.00 EUR"
    # authorise from the holds page; held grows, list shows the new open item without a reload
    await page.goto("/authorizations")
    await page.fill(sel("authorize-handle"), "cy")
    await page.fill(sel("authorize-amount"), "5")
    await page.click(sel("authorize-submit"))
    await page.wait_for_selector(f"{sel('wallet-held')}[data-amount='2500']")
    items = await page.eval_on_selector_all(f"{sel('authorization-list')} > *", "els => els.map(e => e.dataset.testid)")
    assert items[-1] == "authorization-item-a_seed", items
    assert await page.get_attribute(sel(items[0]), "data-status") == "open"
    assert await page.query_selector(sel("authorization-void-a_seed"))
    assert await page.query_selector(sel("authorization-capture-a_seed")) is None
    exp = (await page.text_content(sel("authorization-expires-a_seed"))).strip()
    s, b = http("GET", f"{BASE}/authorizations", token=token_of("ada@example.com"))
    assert exp == [a for a in b["authorizations"] if a["authorization_id"] == "a_seed"][0]["expires_at"]
    # refused authorise: too much
    await page.fill(sel("authorize-amount"), "999")
    await page.click(sel("authorize-submit"))
    await page.wait_for_selector(sel("authorize-error"))
    # void releases
    await page.click(sel("authorization-void-a_seed"))
    await page.wait_for_selector(f"{sel('authorization-item-a_seed')}[data-status='voided']")
    await page.wait_for_selector(f"{sel('wallet-held')}[data-amount='500']")
    # receiver captures part of a fresh hold (prefilled remaining), captured shown only when captured
    ada = token_of("ada@example.com")
    s, a = http("POST", f"{BASE}/authorizations", {"to_handle": "bob", "amount": 1234}, ada, str(uuid.uuid4()))
    ctx2 = await browser.new_context(base_url=BASE)
    p2 = await ctx2.new_page()
    await log_in(p2, "bob@example.com")
    await p2.goto("/authorizations")
    aid = a["authorization_id"]
    await p2.wait_for_selector(sel(f"authorization-capture-amount-{aid}"))
    assert await p2.input_value(sel(f"authorization-capture-amount-{aid}")) == "12.34"
    assert await p2.query_selector(sel(f"authorization-captured-{aid}")) is None
    await p2.fill(sel(f"authorization-capture-amount-{aid}"), "10")
    await p2.click(sel(f"authorization-capture-{aid}"))
    await p2.wait_for_selector(f"{sel('authorization-item-' + aid)}[data-status='captured']")
    assert (await p2.text_content(sel(f"authorization-captured-{aid}"))).strip() == "10.00 EUR"
    # capture again refused path: void by ada elsewhere then bob capture -> error
    s, a2 = http("POST", f"{BASE}/authorizations", {"to_handle": "bob", "amount": 100}, ada, str(uuid.uuid4()))
    await p2.click(sel("wallet-refresh"))
    await p2.wait_for_selector(sel(f"authorization-capture-{a2['authorization_id']}"))
    http("POST", f"{BASE}/authorizations/{a2['authorization_id']}/void", {}, ada)
    await p2.click(sel(f"authorization-capture-{a2['authorization_id']}"))
    await p2.wait_for_selector(sel("authorization-error"))
    await p2.wait_for_selector(f"{sel('authorization-item-' + a2['authorization_id'])}[data-status='voided']")
    await ctx.close()
    await ctx2.close()


# ---------------------------------------------------------------- decimals

@probe
async def decimal_rejections_send_nothing(browser):
    for currency, mu, bad in (("EUR", 2, ["15.005", "abc", "15.", ".5", "1,5", "-3", "0", "0.00"]), ("JPY", 0, ["15.5", "1e3", "abc"])):
        reset(fixture(currency, mu))
        ctx = await browser.new_context(base_url=BASE)
        page = await ctx.new_page()
        await log_in(page)
        await page.goto("/")
        await page.wait_for_selector(sel("pay-submit"))
        posts = []
        page.on("request", lambda r: posts.append(r.url) if r.method == "POST" else None)
        for v in bad:
            await page.fill(sel("pay-handle"), "bob")
            await page.fill(sel("pay-amount"), v)
            await page.click(sel("pay-submit"))
            await page.wait_for_selector(sel("pay-error"))
        for form, prefix in (("request", "request"), ("authorize", "authorize")):
            await page.fill(sel(f"{prefix}-handle"), "bob")
            await page.fill(sel(f"{prefix}-amount"), bad[0])
            await page.click(sel(f"{prefix}-submit"))
            await page.wait_for_selector(sel(f"{prefix}-error"))
        await page.wait_for_timeout(200)
        assert posts == [], f"{currency}: invalid input was sent: {posts}"
        expected = "10000 JPY" if mu == 0 else "100.00 EUR"
        assert (await page.text_content(sel("wallet-balance"))).strip() == expected
        # valid forms: 15 / 15.5 (EUR) and 15 (JPY)
        await page.fill(sel("pay-amount"), "15" if mu == 0 else "15.5")
        await page.click(sel("pay-submit"))
        want = 10000 - (15 if mu == 0 else 1550)
        await page.wait_for_selector(f"{sel('wallet-balance')}[data-amount='{want}']")
        assert await page.query_selector(sel("pay-error")) is None
        await ctx.close()
    reset(fixture("BHD", 3))
    ctx = await browser.new_context(base_url=BASE)
    page = await ctx.new_page()
    await log_in(page)
    await page.wait_for_selector(sel("wallet-balance"))
    assert (await page.text_content(sel("wallet-balance"))).strip() == "10.000 BHD"
    await page.fill(sel("pay-handle"), "bob")
    await page.fill(sel("pay-amount"), "1.5")
    await page.click(sel("pay-submit"))
    await page.wait_for_selector(f"{sel('wallet-balance')}[data-amount='8500']")
    await ctx.close()


# ---------------------------------------------------------------- idempotent forms

@probe
async def unchanged_resubmit_and_change(browser):
    reset(fixture())
    ctx = await browser.new_context(base_url=BASE)
    page = await ctx.new_page()
    await log_in(page)
    await page.fill(sel("pay-handle"), "bob")
    await page.fill(sel("pay-amount"), "15.00")
    await page.fill(sel("pay-note"), "dinner 🍝")
    await page.select_option(sel("pay-visibility"), "private")
    await page.click(sel("pay-submit"))
    await page.wait_for_selector(f"{sel('wallet-balance')}[data-amount='8500']")
    assert await page.input_value(sel("pay-amount")) == "15.00"
    assert await page.input_value(sel("pay-visibility")) == "private"
    for _ in range(2):
        await page.click(sel("pay-submit"))
        await page.wait_for_timeout(400)
    assert await page.query_selector(sel("pay-error")) is None
    assert await amount_attr(page) == "8500"
    feed = await page.eval_on_selector_all(f"{sel('activity-list')} > *", "els => els.map(e => e.dataset.visibility)")
    assert feed == ["private"], feed
    await page.fill(sel("pay-note"), "dinner 🍝 again")
    await page.click(sel("pay-submit"))
    await page.wait_for_selector(f"{sel('wallet-balance')}[data-amount='7000']")
    await ctx.close()


@probe
async def lost_response_is_uncertain_then_retry_once(browser):
    reset(fixture())
    ctx = await browser.new_context(base_url=BASE)
    page = await ctx.new_page()
    await log_in(page)
    sent_keys = []

    async def lose(route):
        sent_keys.append(route.request.headers.get("idempotency-key"))
        await route.fetch()          # the server commits the payment
        await route.abort()          # ... but the browser never sees the answer

    await page.route("**/payments", lose)
    await page.fill(sel("pay-handle"), "bob")
    await page.fill(sel("pay-amount"), "15.00")
    await page.click(sel("pay-submit"))
    await page.wait_for_selector(sel("pay-uncertain"))
    assert (await page.text_content(sel("pay-uncertain"))).strip()
    assert await page.query_selector(sel("pay-error")) is None
    await page.unroute("**/payments")
    keys = []
    page.on("request", lambda r: keys.append(r.headers.get("idempotency-key")) if r.url.endswith("/payments") else None)
    await page.click(sel("pay-submit"))
    await page.wait_for_selector(f"{sel('wallet-balance')}[data-amount='8500']")
    await page.wait_for_selector(sel("pay-uncertain"), state="detached")
    assert await page.query_selector(sel("pay-error")) is None
    assert keys == sent_keys, (keys, sent_keys)
    s, b = http("GET", f"{BASE}/activity", token=token_of("ada@example.com"))
    assert len([p for p in b["payments"] if p["amount"] == 1500]) == 1
    # a 5xx is also an unknown outcome
    async def boom(route):
        await route.fulfill(status=503, body="")
    await page.route("**/payments", boom)
    await page.fill(sel("pay-amount"), "1.00")
    await page.click(sel("pay-submit"))
    await page.wait_for_selector(sel("pay-uncertain"))
    await page.unroute("**/payments")
    await page.click(sel("pay-submit"))
    await page.wait_for_selector(f"{sel('wallet-balance')}[data-amount='8400']")
    await ctx.close()


@probe
async def latest_refresh_wins(browser):
    reset(fixture())
    ctx = await browser.new_context(base_url=BASE)
    page = await ctx.new_page()
    await log_in(page)
    await page.wait_for_selector(f"{sel('wallet-balance')}[data-amount='10000']")
    await page.fill(sel("pay-handle"), "cy")
    await page.fill(sel("pay-amount"), "7")
    calls = {"n": 0}

    async def slow_first(route):
        calls["n"] += 1
        if calls["n"] == 1:
            resp = await route.fetch()          # read the OLD state now ...
            await asyncio.sleep(1.5)            # ... and deliver it late
            await route.fulfill(response=resp)
        else:
            await route.continue_()

    await page.route("**/me", slow_first)
    await page.route("**/activity*", slow_first)
    await page.click(sel("wallet-refresh"))                   # read 1 (old), delayed
    await page.wait_for_timeout(200)
    ada = token_of("ada@example.com")
    s, p = http("POST", f"{BASE}/payments", {"to_handle": "bob", "amount": 300}, ada, str(uuid.uuid4()))
    assert s == 201
    await page.click(sel("wallet-refresh"))                   # read 2 (new), immediate
    await page.wait_for_selector(f"{sel('wallet-balance')}[data-amount='9700']")
    await page.wait_for_timeout(2000)                         # old read lands now
    assert await amount_attr(page) == "9700", "a delayed earlier read overwrote a later refresh"
    assert await page.query_selector(sel(f"activity-item-{p['payment_id']}"))
    assert await page.input_value(sel("pay-amount")) == "7", "refresh must keep the pay form"
    await ctx.close()


@probe
async def refused_payment_refreshes_and_keeps_inputs(browser):
    reset(fixture())
    ctx = await browser.new_context(base_url=BASE)
    page = await ctx.new_page()
    await log_in(page, "cy@example.com")
    await page.wait_for_selector(f"{sel('wallet-balance')}[data-amount='500']")
    cy = token_of("cy@example.com")
    http("POST", f"{BASE}/payments", {"to_handle": "bob", "amount": 400}, cy, str(uuid.uuid4()))   # spent elsewhere
    await page.fill(sel("pay-handle"), "ada")
    await page.fill(sel("pay-amount"), "3.00")
    await page.fill(sel("pay-note"), "lunch")
    await page.click(sel("pay-submit"))
    await page.wait_for_selector(sel("pay-error"))
    await page.wait_for_selector(f"{sel('wallet-balance')}[data-amount='100']")
    assert [await page.input_value(sel(t)) for t in ("pay-handle", "pay-amount", "pay-note")] == ["ada", "3.00", "lunch"]
    await ctx.close()


@probe
async def stale_request_pay_button(browser):
    reset(fixture())
    bob = token_of("bob@example.com")
    s, r = http("POST", f"{BASE}/requests", {"payer_handle": "ada", "amount": 100}, bob, str(uuid.uuid4()))
    rid = r["request_id"]
    ctx = await browser.new_context(base_url=BASE)
    page = await ctx.new_page()
    await log_in(page)
    await page.goto("/requests")
    await page.wait_for_selector(sel(f"request-pay-{rid}"))
    http("POST", f"{BASE}/requests/{rid}/cancel", {}, bob)
    await page.click(sel(f"request-pay-{rid}"))
    await page.wait_for_selector(sel("request-error"))
    await page.wait_for_selector(f"{sel('request-item-' + rid)}[data-status='cancelled']")
    assert await page.query_selector(sel(f"request-pay-{rid}")) is None
    await ctx.close()


@probe
async def split_preview_equals_server_shares(browser):
    reset(fixture(users=[user("ada", 10000), user("bob", 2500), user("cy", 500), user("dee", 0)]))
    ctx = await browser.new_context(base_url=BASE)
    page = await ctx.new_page()
    await log_in(page)
    await page.goto("/split")
    await page.fill(sel("split-amount"), "0.05")
    await page.fill(sel("split-handles"), " dee , bob,ada , cy ")
    await page.wait_for_selector(sel("split-preview"))
    preview = [(await page.text_content(sel(f"split-share-{h}"))).strip() for h in ("dee", "bob", "ada", "cy")]
    assert preview == ["0.02 EUR", "0.01 EUR", "0.01 EUR", "0.01 EUR"], preview
    await page.fill(sel("split-note"), "pizza")
    await page.click(sel("split-submit"))
    ada = token_of("ada@example.com")
    for _ in range(50):
        s, b = http("GET", f"{BASE}/requests?direction=outgoing", token=ada)
        if b["requests"]:
            break
        await page.wait_for_timeout(100)
    server = {r["payer_handle"]: r["amount"] for r in b["requests"]}
    assert server == {"dee": 2, "bob": 1, "cy": 1}, server
    await page.wait_for_timeout(300)
    await page.click(sel("split-submit"))                    # unchanged resubmit: a replay
    await page.wait_for_timeout(500)
    s, b = http("GET", f"{BASE}/requests?direction=outgoing", token=ada)
    assert len(b["requests"]) == 3
    assert await page.query_selector(sel("split-error")) is None
    await ctx.close()


@probe
async def auth_screens(browser):
    reset(fixture())
    ctx = await browser.new_context(base_url=BASE)
    page = await ctx.new_page()
    await page.goto("/")
    await page.wait_for_url("**/login")
    assert await page.query_selector(sel("auth-error")) is None
    await page.fill(sel("login-email"), "ada@example.com")
    await page.fill(sel("login-password"), "wrong password")
    await page.click(sel("login-submit"))
    await page.wait_for_selector(sel("auth-error"))
    await page.goto("/signup")
    await page.fill(sel("signup-email"), "Dee.Ann@example.com")
    await page.fill(sel("signup-password"), "short")
    await page.fill(sel("signup-display-name"), "Dee")
    await page.click(sel("signup-submit"))
    await page.wait_for_selector(sel("auth-error"))
    await page.fill(sel("signup-password"), "long enough")
    await page.click(sel("signup-submit"))
    await page.wait_for_selector(sel("current-user"))
    assert (await page.text_content(sel("current-handle"))).strip() == "dee_ann"
    await page.wait_for_selector(sel("empty-activity"))
    await page.goto("/requests")
    await page.wait_for_selector(sel("empty-requests"))
    await page.goto("/authorizations")
    await page.wait_for_selector(sel("empty-authorizations"))
    assert await page.query_selector(sel("wallet-held")) is None
    await page.click(sel("logout-button"))
    await page.wait_for_selector(sel("current-user"), state="detached")
    await page.wait_for_url("**/login")
    # token cleared: protected route goes to login
    await page.goto("/split")
    await page.wait_for_url("**/login")
    # a token the server forgot (reset) sends the browser to /login
    await log_in(page)
    reset(fixture())
    await page.goto("/")
    await page.wait_for_url("**/login")
    await ctx.close()


# ---------------------------------------------------------------- upgrade

@probe
async def upgrade_keeps_session_and_pending_retry(browser):
    # (a) a signed-in browser with a lost payment survives export -> fresh deploy -> import
    reset(fixture())
    ctx = await browser.new_context(base_url=BASE)
    page = await ctx.new_page()
    await log_in(page)
    await page.wait_for_selector(f"{sel('wallet-balance')}[data-amount='10000']")

    async def lose(route):
        await route.fetch()
        await route.abort()
    await page.route("**/payments", lose)
    await page.fill(sel("pay-handle"), "bob")
    await page.fill(sel("pay-amount"), "12.00")
    await page.click(sel("pay-submit"))
    await page.wait_for_selector(sel("pay-uncertain"))
    await page.unroute("**/payments")
    s, snap = http("GET", f"{BASE}/_test/export")
    reset({"currency": "EUR", "minor_units": 2, "users": [user("zed", 1)]})
    s, _ = http("POST", f"{BASE}/_test/import", snap)
    assert s == 204
    await page.click(sel("pay-submit"))                       # same key + body after the upgrade
    await page.wait_for_selector(sel("pay-uncertain"), state="detached")
    await page.wait_for_selector(f"{sel('wallet-balance')}[data-amount='8800']")
    assert await page.query_selector(sel("current-user"))
    s, b = http("GET", f"{BASE}/activity", token=token_of("ada@example.com"))
    assert len([p for p in b["payments"] if p["amount"] == 1200]) == 1
    await ctx.close()
    # (b) real stage-1 export: a stage-1 token keeps working in the stage-2 browser, pending request payable
    if not S1BASE:
        print("   (skipped stage-1 source: S1BASE not set)")
        return
    reset(fixture(requests=[{"id": "rq_old", "requester_id": "u_bob", "payer_id": "u_ada", "amount": 1200, "note": "taxi", "status": "pending"}]), S1BASE)
    t1 = token_of("ada@example.com", S1BASE)
    key = str(uuid.uuid4())
    s, lost = http("POST", f"{S1BASE}/payments", {"to_handle": "cy", "amount": 300}, t1, key)
    s, snap = http("GET", f"{S1BASE}/_test/export")
    reset(fixture())
    s, _ = http("POST", f"{BASE}/_test/import", snap)
    assert s == 204
    ctx = await browser.new_context(base_url=BASE)
    await ctx.add_init_script(f"localStorage.setItem('pocketful.token', {json.dumps(t1)})")
    page = await ctx.new_page()
    await page.goto("/")
    await page.wait_for_selector(f"{sel('wallet-balance')}[data-amount='9700']")
    await page.goto("/requests")
    await page.click(sel("request-pay-rq_old"))
    await page.wait_for_selector(f"{sel('request-item-rq_old')}[data-status='paid']")
    s, again = http("POST", f"{BASE}/payments", {"to_handle": "cy", "amount": 300}, t1, key)
    assert s == 200 and again == lost
    await ctx.close()


async def main():
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
    only = sys.argv[1:]
    failures = 0
    async with async_playwright() as pw:
        host = BASE.split("//", 1)[1]
        browser = await pw.chromium.launch(channel="chromium", args=[f"--unsafely-treat-insecure-origin-as-secure=http://{host}"])
        for fn in RESULTS:
            if only and fn.__name__ not in only:
                continue
            t0 = time.time()
            try:
                await fn(browser)
                print(f"ok   {fn.__name__} ({time.time() - t0:.1f}s)")
            except Exception as e:  # noqa: BLE001
                failures += 1
                print(f"FAIL {fn.__name__}: {type(e).__name__}: {str(e)[:600]}")
        await browser.close()
    print(f"{len(RESULTS) - failures if not only else len(only) - failures} passed, {failures} failed")
    sys.exit(1 if failures else 0)


asyncio.run(main())
