"""Reviewer browser probes for W2b (rev b355029), independent of the implementer's ui_probe.py.

Run with the harness venv (Playwright + Chromium):
  BASE=http://127.0.0.1:19090 <venv>/python stage-2/review/rev-w2b-ui-probe.py
"""
import asyncio
import json
import os
import urllib.request
from datetime import datetime, timedelta, timezone

from playwright.async_api import async_playwright, expect

BASE = os.environ.get("BASE", "http://127.0.0.1:19090")
PW = "correct horse"
results = []


def check(name, cond, detail=""):
    results.append((bool(cond), name, detail))
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else f" :: {detail}"), flush=True)


def http(method, path, body=None, token=None, key=None, accept="application/json"):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if accept is not None:
        req.add_header("Accept", accept)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if key:
        req.add_header("Idempotency-Key", key)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, r.headers.get("content-type", ""), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("content-type", ""), e.read()


def api(method, path, body=None, token=None, key=None):
    s, _, raw = http(method, path, body, token, key)
    return s, (json.loads(raw) if raw else None)


def U(h, bal, **kw):
    return {"id": f"u_{h}", "email": f"{h}@example.com", "password": PW, "display_name": h.title(), "handle": h, "balance": bal, **kw}


def iso(dt):
    return dt.isoformat(timespec="seconds")


def reset(fx):
    s, b = api("POST", "/_test/reset", fx)
    assert s == 204, (s, b)


def tok(h):
    return api("POST", "/auth/login", {"email": f"{h}@example.com", "password": PW})[1]["token"]


LONG = "x" * 200
XSS = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>'
NOTE_WS = "  two  spaces\tand tab  "
NOTE_EMOJI = "👨‍👩‍👧 café é"
HANDLE20 = "abcdefghijklmnopqrst"


async def overflow_report(page):
    return await page.evaluate("""() => {
      const vw = document.documentElement.clientWidth;
      const sw = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
      let worst = null;
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const st = getComputedStyle(el);
        if (st.position === 'absolute' && el.classList.contains('sr-only')) continue;
        if (el.classList.contains('skip')) continue;
        if (r.right > vw + 1 && (!worst || r.right > worst.right)) worst = { right: r.right, tag: el.tagName, tid: el.dataset.testid || el.className };
      }
      return { vw, sw, worst };
    }""")


async def dup_testids(page):
    return await page.evaluate("""() => { const c = {}; for (const e of document.querySelectorAll('[data-testid]')) c[e.dataset.testid] = (c[e.dataset.testid]||0)+1;
      return Object.entries(c).filter(([k,v]) => v > 1); }""")


async def login(page, h):
    await page.goto(BASE + "/login")
    await page.get_by_test_id("login-email").fill(f"{h}@example.com")
    await page.get_by_test_id("login-password").fill(PW)
    await page.get_by_test_id("login-submit").click()
    await expect(page.get_by_test_id("wallet-available")).to_be_visible()


async def main():
    now = datetime.now(timezone.utc)
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        external = []

        async def new_page(width=375):
            ctx = await browser.new_context(viewport={"width": width, "height": 900})
            pg = await ctx.new_page()
            pg.on("request", lambda r: external.append(r.url) if not r.url.startswith(BASE) and not r.url.startswith("data:") else None)
            pg.on("dialog", lambda d: asyncio.ensure_future(d.dismiss()))
            return pg

        # ---------- Accept negotiation ----------
        reset({"currency": "EUR", "minor_units": 2, "users": [U("ada", 10000)]})
        t = tok("ada")
        for acc, want_html in [(None, False), ("*/*", False), ("application/json", False), ("text/html", True),
                               ("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", True)]:
            for path in ["/requests", "/authorizations"]:
                s, ct, raw = http("GET", path, token=t, accept=acc)
                is_html = "text/html" in ct
                check(f"negotiate {path} Accept={acc} -> {'html' if want_html else 'json'}", s == 200 and is_html == want_html, f"{s} {ct}")
        s, ct, _ = http("GET", "/requests", accept=None)
        check("GET /requests no token no Accept -> 401 json", s == 401 and "json" in ct, f"{s} {ct}")
        for path in ["/", "/split", "/signup", "/login"]:
            s, ct, _ = http("GET", path, accept="text/html")
            check(f"GET {path} html", s == 200 and "text/html" in ct, f"{s} {ct}")
        for path in ["/statements", "/me/statement"]:
            s, ct, _ = http("GET", path, token=t)
            check(f"no stage-3 route {path}", s == 404, s)

        # ---------- rich fixture (EUR) ----------
        fx = {"currency": "EUR", "minor_units": 2,
              "users": [U("ada", 10000, display_name=XSS), U("bob", 2500), U("cy", 0), U(HANDLE20, 900719925474099)],
              "payments": [
                  {"id": "p_empty", "from_user_id": "u_bob", "to_user_id": "u_ada", "amount": 1, "note": ""},
                  {"id": "p_ws", "from_user_id": "u_bob", "to_user_id": "u_ada", "amount": 2, "note": NOTE_WS},
                  {"id": "p_xss", "from_user_id": "u_bob", "to_user_id": "u_ada", "amount": 3, "note": XSS},
                  {"id": "p_long", "from_user_id": f"u_{HANDLE20}", "to_user_id": "u_ada", "amount": 1000000000, "note": LONG},
                  {"id": "p_emoji", "from_user_id": "u_bob", "to_user_id": "u_ada", "amount": 4, "note": NOTE_EMOJI, "visibility": "private"},
                  {"id": "p_priv_other", "from_user_id": "u_bob", "to_user_id": "u_cy", "amount": 5, "visibility": "private"}],
              "requests": [
                  {"id": "rq_in_p", "requester_id": "u_bob", "payer_id": "u_ada", "amount": 100, "note": XSS},
                  {"id": "rq_in_paid", "requester_id": "u_bob", "payer_id": "u_ada", "amount": 101, "status": "paid"},
                  {"id": "rq_out_p", "requester_id": "u_ada", "payer_id": "u_bob", "amount": 102},
                  {"id": "rq_out_dec", "requester_id": "u_ada", "payer_id": "u_bob", "amount": 103, "status": "declined"},
                  {"id": "rq_in_canc", "requester_id": "u_bob", "payer_id": "u_ada", "amount": 104, "status": "cancelled"}],
              "authorizations": [
                  {"id": "a_out_open", "from_user_id": "u_ada", "to_user_id": "u_bob", "amount": 2000, "status": "open", "expires_at": iso(now + timedelta(hours=2))},
                  {"id": "a_in_open", "from_user_id": "u_bob", "to_user_id": "u_ada", "amount": 1234, "captured_amount": 234, "status": "open", "expires_at": "2099-01-01T05:00:00+05:00"},
                  {"id": "a_in_capt", "from_user_id": "u_bob", "to_user_id": "u_ada", "amount": 500, "status": "captured", "expires_at": iso(now + timedelta(hours=2))},
                  {"id": "a_out_exp", "from_user_id": "u_ada", "to_user_id": "u_bob", "amount": 700, "status": "open", "expires_at": iso(now - timedelta(hours=2))},
                  {"id": "a_out_void", "from_user_id": "u_ada", "to_user_id": "u_bob", "amount": 800, "status": "voided", "expires_at": iso(now + timedelta(hours=2))}]}
        reset(fx)
        page = await new_page(375)
        await page.goto(BASE + "/")
        check("unauth / redirects to /login", page.url.endswith("/login"), page.url)
        await page.get_by_test_id("login-submit").click()
        await expect(page.get_by_test_id("auth-error")).to_be_visible()
        await page.get_by_test_id("login-email").fill("ada@example.com")
        await page.get_by_test_id("login-password").fill("wrong-password")
        await page.get_by_test_id("login-submit").click()
        await expect(page.get_by_test_id("auth-error")).to_be_visible()
        await page.get_by_test_id("login-password").fill(PW)
        await page.get_by_test_id("login-submit").click()
        await expect(page.get_by_test_id("wallet-available")).to_be_visible()
        check("auth-error absent after login", await page.get_by_test_id("auth-error").count() == 0)
        await page.wait_for_timeout(500)
        check("XSS display name rendered as text", await page.get_by_test_id("current-user").text_content() == XSS and await page.evaluate("window.__xss") is None,
              await page.get_by_test_id("current-user").text_content())
        check("current-handle exact", await page.get_by_test_id("current-handle").text_content() == "ada")
        check("wallet-balance exact", await page.get_by_test_id("wallet-balance").text_content() == "100.00 EUR"
              and await page.get_by_test_id("wallet-balance").get_attribute("data-amount") == "10000")
        check("wallet-available 80.00", await page.get_by_test_id("wallet-available").text_content() == "80.00 EUR"
              and await page.get_by_test_id("wallet-available").get_attribute("data-amount") == "8000")
        check("wallet-held 20.00", await page.get_by_test_id("wallet-held").text_content() == "20.00 EUR"
              and await page.get_by_test_id("wallet-held").get_attribute("data-amount") == "2000")
        await expect(page.get_by_test_id("activity-list")).to_be_visible()
        notes = {pid: await page.get_by_test_id(f"activity-note-{pid}").text_content() for pid in ["p_empty", "p_ws", "p_xss", "p_long", "p_emoji"]}
        check("activity-note empty present & exact", await page.get_by_test_id("activity-note-p_empty").count() == 1 and notes["p_empty"] == "", repr(notes["p_empty"]))
        check("activity-note whitespace exact", notes["p_ws"] == NOTE_WS, repr(notes["p_ws"]))
        check("activity-note XSS as text", notes["p_xss"] == XSS and await page.evaluate("window.__xss") is None and await page.locator("img[src=x]").count() == 0, repr(notes["p_xss"]))
        check("activity-note emoji exact", notes["p_emoji"] == NOTE_EMOJI, repr(notes["p_emoji"]))
        try:
            await expect(page.get_by_test_id("activity-note-p_ws")).to_have_text(NOTE_WS)
            check("to_have_text whitespace note", True)
        except AssertionError as e:
            check("to_have_text whitespace note", False, str(e)[:200])
        check("activity-amount large exact", await page.get_by_test_id("activity-amount-p_long").text_content() == "10000000.00 EUR")
        parties = await page.get_by_test_id("activity-parties-p_long").text_content()
        check("activity-parties both handles", HANDLE20 in parties and "ada" in parties, parties)
        check("private item data-visibility", await page.get_by_test_id("activity-item-p_emoji").get_attribute("data-visibility") == "private")
        check("third-party private not shown", await page.get_by_test_id("activity-item-p_priv_other").count() == 0)
        ids = await page.eval_on_selector_all("[data-testid=activity-list] > *", "els => els.map(e => e.dataset.testid)")
        check("activity newest first (seed order reversed)", ids[:5] == ["activity-item-p_emoji", "activity-item-p_long", "activity-item-p_xss", "activity-item-p_ws", "activity-item-p_empty"], ids)
        check("open hold not in feed", await page.locator("[data-testid^=activity-item-]").count() == 5)
        for route in ["/", "/requests", "/split", "/authorizations"]:
            await page.goto(BASE + route)
            await page.wait_for_load_state("networkidle")
            await page.wait_for_timeout(300)
            rep = await overflow_report(page)
            check(f"375 no horizontal scroll {route}", rep["sw"] <= rep["vw"], rep)
            check(f"375 nothing clipped past viewport {route}", rep["worst"] is None, rep)
            d = await dup_testids(page)
            check(f"no duplicate testids {route}", not d, d)
            check(f"current-user on {route}", await page.get_by_test_id("current-user").is_visible())
        # requests page semantics
        await page.goto(BASE + "/requests")
        await expect(page.get_by_test_id("incoming-list")).to_be_attached()
        await expect(page.get_by_test_id("request-item-rq_in_p")).to_be_visible()
        exp = {"rq_in_p": ("pending", True, True, False), "rq_in_paid": ("paid", False, False, False), "rq_out_p": ("pending", False, False, True),
               "rq_out_dec": ("declined", False, False, False), "rq_in_canc": ("cancelled", False, False, False)}
        for rid, (st, pay, dec, can) in exp.items():
            item = page.get_by_test_id(f"request-item-{rid}")
            ok = (await item.get_attribute("data-status") == st and (await page.get_by_test_id(f"request-pay-{rid}").count() == 1) == pay
                  and (await page.get_by_test_id(f"request-decline-{rid}").count() == 1) == dec and (await page.get_by_test_id(f"request-cancel-{rid}").count() == 1) == can)
            check(f"request {rid} status/buttons", ok)
        check("incoming in incoming-list", await page.locator("[data-testid=incoming-list] [data-testid=request-item-rq_in_p]").count() == 1
              and await page.locator("[data-testid=outgoing-list] [data-testid=request-item-rq_out_p]").count() == 1)
        check("request-amount exact", await page.get_by_test_id("request-amount-rq_in_p").text_content() == "1.00 EUR")
        check("empty-requests absent", await page.get_by_test_id("empty-requests").count() == 0)
        check("request-error absent initially", await page.get_by_test_id("request-error").count() == 0)
        # cancelled elsewhere then pay -> request-error, list refreshed
        api("POST", "/requests/rq_in_p/cancel", token=tok("bob"))
        await page.get_by_test_id("request-pay-rq_in_p").click()
        await expect(page.get_by_test_id("request-error")).to_be_visible()
        await expect(page.get_by_test_id("request-pay-rq_in_p")).to_have_count(0)
        check("cancelled-elsewhere -> error + stale pay gone", await page.get_by_test_id("request-item-rq_in_p").get_attribute("data-status") == "cancelled")
        # decline / cancel through UI
        bt = tok("bob")
        api("POST", "/requests", {"payer_handle": "ada", "amount": 55}, token=bt, key="mk1")
        await page.reload()
        s, b = api("GET", "/requests?direction=incoming&status=pending", token=tok("ada"))
        rid = b["requests"][0]["request_id"]
        await page.get_by_test_id(f"request-decline-{rid}").click()
        await expect(page.get_by_test_id(f"request-item-{rid}")).to_have_attribute("data-status", "declined")
        check("decline via UI", True)
        await page.get_by_test_id("request-cancel-rq_out_p").click()
        await expect(page.get_by_test_id("request-item-rq_out_p")).to_have_attribute("data-status", "cancelled")
        check("cancel via UI", await page.get_by_test_id("request-cancel-rq_out_p").count() == 0)
        # authorizations page semantics
        await page.goto(BASE + "/authorizations")
        await expect(page.get_by_test_id("authorization-list")).to_be_visible()
        A = {"a_out_open": ("open", False, True, False), "a_in_open": ("open", True, False, False), "a_in_capt": ("captured", False, False, True),
             "a_out_exp": ("expired", False, False, False), "a_out_void": ("voided", False, False, False)}
        for aid, (st, cap, void, captured) in A.items():
            ok = (await page.get_by_test_id(f"authorization-item-{aid}").get_attribute("data-status") == st
                  and (await page.get_by_test_id(f"authorization-capture-{aid}").count() == 1) == cap
                  and (await page.get_by_test_id(f"authorization-capture-amount-{aid}").count() == 1) == cap
                  and (await page.get_by_test_id(f"authorization-void-{aid}").count() == 1) == void
                  and (await page.get_by_test_id(f"authorization-captured-{aid}").count() == 1) == captured)
            check(f"auth {aid} status/controls", ok)
        check("authorization-expires exact (offset kept)", await page.get_by_test_id("authorization-expires-a_in_open").text_content() == "2099-01-01T05:00:00+05:00")
        check("authorization-amount exact", await page.get_by_test_id("authorization-amount-a_in_open").text_content() == "12.34 EUR")
        check("capture prefilled with remaining", await page.get_by_test_id("authorization-capture-amount-a_in_open").input_value() == "10.00")
        check("authorization-captured exact", await page.get_by_test_id("authorization-captured-a_in_capt").text_content() == "5.00 EUR")
        # capture partial 2.50 (final default) via UI
        await page.get_by_test_id("authorization-capture-amount-a_in_open").fill("2.505")
        await page.get_by_test_id("authorization-capture-a_in_open").click()
        await expect(page.get_by_test_id("authorization-error")).to_be_visible()
        await page.get_by_test_id("authorization-capture-amount-a_in_open").fill("2.50")
        await page.get_by_test_id("authorization-capture-a_in_open").click()
        await expect(page.get_by_test_id("authorization-item-a_in_open")).to_have_attribute("data-status", "captured")
        check("capture final via UI -> captured 4.84", await page.get_by_test_id("authorization-captured-a_in_open").text_content() == "4.84 EUR"
              and await page.get_by_test_id("authorization-error").count() == 0)
        await page.get_by_test_id("authorization-void-a_out_open").click()
        await expect(page.get_by_test_id("authorization-item-a_out_open")).to_have_attribute("data-status", "voided")
        await expect(page.get_by_test_id("wallet-held")).to_have_count(0)
        check("void via UI releases; wallet-held absent at 0", True)
        # focus visibility
        await page.goto(BASE + "/")
        await expect(page.get_by_test_id("pay-handle")).to_be_visible()
        await page.get_by_test_id("pay-handle").focus()
        await page.keyboard.press("Tab")
        ol = await page.evaluate("() => { const s = getComputedStyle(document.activeElement); return [document.activeElement.dataset.testid, s.outlineStyle, s.outlineWidth]; }")
        check("keyboard focus visible", ol[1] != "none" and ol[2] != "0px", ol)
        await page.context.close()

        # ---------- formatting across currencies ----------
        for cur, mu, bal, want in [("JPY", 0, 1200, "1200 JPY"), ("JPY", 0, 0, "0 JPY"), ("BHD", 3, 1500, "1.500 BHD"), ("BHD", 3, 5, "0.005 BHD"),
                                   ("EUR", 2, 0, "0.00 EUR"), ("EUR", 2, 7, "0.07 EUR"), ("EUR", 2, 9007199254740991, "90071992547409.91 EUR")]:
            reset({"currency": cur, "minor_units": mu, "users": [U("ada", bal), U("bob", 0)]})
            pg = await new_page(375)
            await login(pg, "ada")
            txt = await pg.get_by_test_id("wallet-balance").text_content()
            check(f"format {cur} {bal} -> {want}", txt == want and await pg.get_by_test_id("wallet-held").count() == 0, txt)
            rep = await overflow_report(pg)
            check(f"no overflow with {want}", rep["worst"] is None and rep["sw"] <= rep["vw"], rep)
            await pg.context.close()

        # ---------- pay form: decimal rules, no POST on rejection ----------
        reset({"currency": "JPY", "minor_units": 0, "users": [U("ada", 5000), U("bob", 0)]})
        pg = await new_page(1280)
        await login(pg, "ada")
        posts = []
        pg.on("request", lambda r: posts.append(r.url) if r.method == "POST" else None)
        for bad in ["15.5", "15.", "abc", "1e3", "-5", "0", ""]:
            await pg.get_by_test_id("pay-handle").fill("bob")
            await pg.get_by_test_id("pay-amount").fill(bad)
            await pg.get_by_test_id("pay-submit").click()
            await expect(pg.get_by_test_id("pay-error")).to_be_visible()
        check("JPY bad amounts rejected client-side, no POST", not [u for u in posts if u.endswith("/payments")], posts)
        await pg.get_by_test_id("pay-amount").fill("1500")
        await pg.get_by_test_id("pay-submit").click()
        await expect(pg.get_by_test_id("wallet-balance")).to_have_text("3500 JPY")
        check("JPY 1500 pays 1500", True)
        await pg.context.close()

        reset({"currency": "EUR", "minor_units": 2, "users": [U("ada", 10000), U("bob", 0), U("cy", 0)]})
        pg = await new_page(375)
        await login(pg, "ada")
        posts = []
        pg.on("request", lambda r: posts.append(r) if r.method == "POST" else None)
        await pg.get_by_test_id("pay-handle").fill("bob")
        for bad in ["15.005", "1,50", "15.", ".5", "x"]:
            await pg.get_by_test_id("pay-amount").fill(bad)
            await pg.get_by_test_id("pay-submit").click()
            await expect(pg.get_by_test_id("pay-error")).to_be_visible()
        check("EUR bad amounts rejected, no POST", not posts, [r.url for r in posts])
        await pg.get_by_test_id("pay-amount").fill("15.5")
        await pg.get_by_test_id("pay-note").fill(NOTE_WS)
        await pg.get_by_test_id("pay-submit").click()
        await expect(pg.get_by_test_id("wallet-balance")).to_have_text("84.50 EUR")
        sent = json.loads(posts[-1].post_data)
        check("15.5 submits 1550 and note verbatim", sent["amount"] == 1550 and sent["note"] == NOTE_WS, sent)
        check("pay-error gone after success, inputs kept", await pg.get_by_test_id("pay-error").count() == 0 and await pg.get_by_test_id("pay-amount").input_value() == "15.5")
        await pg.get_by_test_id("pay-submit").click()
        await pg.wait_for_timeout(800)
        s, b = api("GET", "/activity", token=tok("ada"))
        check("unchanged resubmit -> one payment", len(b["payments"]) == 1 and await pg.get_by_test_id("wallet-balance").text_content() == "84.50 EUR" and await pg.get_by_test_id("pay-error").count() == 0)

        # lost response after commit (payments)
        state = {"n": 0}

        async def lose_first(route):
            state["n"] += 1
            if state["n"] == 1:
                await route.fetch()
                await route.abort()
            else:
                await route.continue_()
        await pg.route("**/payments", lose_first)
        await pg.get_by_test_id("pay-amount").fill("1")
        await pg.get_by_test_id("pay-submit").click()
        await expect(pg.get_by_test_id("pay-uncertain")).to_be_visible()
        check("lost pay -> pay-uncertain nonempty, no pay-error", (await pg.get_by_test_id("pay-uncertain").text_content()).strip() != "" and await pg.get_by_test_id("pay-error").count() == 0)
        keys = [r.headers.get("idempotency-key") for r in posts if r.url.endswith("/payments")]
        await pg.get_by_test_id("pay-submit").click()
        await expect(pg.get_by_test_id("pay-uncertain")).to_have_count(0)
        await expect(pg.get_by_test_id("wallet-balance")).to_have_text("83.50 EUR")
        keys2 = [r.headers.get("idempotency-key") for r in posts if r.url.endswith("/payments")]
        s, b = api("GET", "/activity", token=tok("ada"))
        check("retry same key, money once", keys2[-1] == keys2[-2] and len(b["payments"]) == 2 and await pg.get_by_test_id("pay-error").count() == 0, keys2)
        await pg.unroute("**/payments")

        # latest refresh wins with reordered responses
        delay = {"first": True}

        async def slow_first_me(route):
            if delay["first"]:
                delay["first"] = False
                resp = await route.fetch()
                body = await resp.body()
                await asyncio.sleep(2.0)
                await route.fulfill(response=resp, body=body)
            else:
                await route.continue_()
        await pg.route("**/me", slow_first_me)
        await pg.get_by_test_id("pay-handle").fill("keep-me")
        await pg.get_by_test_id("wallet-refresh").click()          # slow, sees 83.50
        await pg.wait_for_timeout(200)
        api("POST", "/payments", {"to_handle": "bob", "amount": 50}, token=tok("ada"), key="other-client")
        await pg.get_by_test_id("wallet-refresh").click()          # fast, sees 83.00
        await expect(pg.get_by_test_id("wallet-balance")).to_have_text("83.00 EUR")
        await pg.wait_for_timeout(2500)
        check("latest refresh wins", await pg.get_by_test_id("wallet-balance").text_content() == "83.00 EUR", await pg.get_by_test_id("wallet-balance").text_content())
        check("refresh keeps pay form", await pg.get_by_test_id("pay-handle").input_value() == "keep-me")
        await pg.unroute("**/me")

        # refused (spent elsewhere) keeps inputs and refreshes
        api("POST", "/payments", {"to_handle": "bob", "amount": 8200}, token=tok("ada"), key="spend")
        await pg.get_by_test_id("pay-handle").fill("bob")
        await pg.get_by_test_id("pay-amount").fill("5.00")
        await pg.get_by_test_id("pay-note").fill("n")
        await pg.get_by_test_id("pay-submit").click()
        await expect(pg.get_by_test_id("pay-error")).to_be_visible()
        await expect(pg.get_by_test_id("wallet-balance")).to_have_text("1.00 EUR")
        check("refused keeps inputs", [await pg.get_by_test_id(x).input_value() for x in ["pay-handle", "pay-amount", "pay-note"]] == ["bob", "5.00", "n"])

        # lost response on other idempotent forms: request, authorize, split
        for form, path, fill_ in [("request", "/requests", {"request-handle": "bob", "request-amount": "0.10"}),
                                  ("authorize", "/authorizations", {"authorize-handle": "bob", "authorize-amount": "0.50"})]:
            def make_lose():
                st = {"n": 0}

                async def lose(route):
                    if route.request.method != "POST":
                        return await route.continue_()
                    st["n"] += 1
                    if st["n"] == 1:
                        await route.fetch()
                        await route.abort()
                    else:
                        await route.continue_()
                return lose
            lose = make_lose()
            await pg.route("**" + path, lose)
            for k_, v in fill_.items():
                await pg.get_by_test_id(k_).fill(v)
            await pg.get_by_test_id(f"{form}-submit").click()
            await expect(pg.get_by_test_id(f"{form}-uncertain")).to_be_visible()
            check(f"{form} lost -> uncertain, not error", await pg.get_by_test_id(f"{form}-error").count() == 0)
            await pg.get_by_test_id(f"{form}-submit").click()
            await expect(pg.get_by_test_id(f"{form}-uncertain")).to_have_count(0)
            await pg.unroute("**" + path)
        s, b = api("GET", "/requests?direction=outgoing", token=tok("ada"))
        check("lost request created exactly once", len(b["requests"]) == 1, len(b["requests"]))
        s, b = api("GET", "/authorizations", token=tok("ada"))
        check("lost authorize created exactly once", len(b["authorizations"]) == 1, len(b["authorizations"]))
        await expect(pg.get_by_test_id("wallet-held")).to_have_text("0.50 EUR")
        check("hold shown after authorize", await pg.get_by_test_id("wallet-available").text_content() == "0.50 EUR")

        # split preview == server, lost split
        await pg.goto(BASE + "/split")
        await pg.get_by_test_id("split-amount").fill("10.00")
        await pg.get_by_test_id("split-handles").fill(" bob , ada,cy ")
        await expect(pg.get_by_test_id("split-preview")).to_be_visible()
        prev = [await pg.get_by_test_id(f"split-share-{h}").text_content() for h in ["bob", "ada", "cy"]]
        check("split preview 3.34/3.33/3.33", prev == ["3.34 EUR", "3.33 EUR", "3.33 EUR"], prev)
        st = {"n": 0}

        async def lose_split(route):
            st["n"] += 1
            if st["n"] == 1:
                await route.fetch()
                await route.abort()
            else:
                await route.continue_()
        await pg.route("**/splits", lose_split)
        await pg.get_by_test_id("split-submit").click()
        await expect(pg.get_by_test_id("split-uncertain")).to_be_visible()
        await pg.get_by_test_id("split-submit").click()
        await expect(pg.get_by_test_id("split-uncertain")).to_have_count(0)
        s, b = api("GET", "/requests?direction=outgoing", token=tok("ada"))
        amts = sorted(r["amount"] for r in b["requests"] if r["amount"] in (333, 334))
        check("lost split created once with server shares == preview", amts == [333, 334], amts)
        await pg.get_by_test_id("split-amount").fill("1.001")
        await pg.get_by_test_id("split-submit").click()
        await expect(pg.get_by_test_id("split-error")).to_be_visible()

        # upgrade-in-place: lost payment, export -> import, retry recovers
        await pg.goto(BASE + "/")
        api("POST", "/payments", {"to_handle": "ada", "amount": 5000}, token=tok("bob"), key="fund")
        await pg.get_by_test_id("wallet-refresh").click()
        st2 = {"n": 0}

        async def lose_pay(route):
            st2["n"] += 1
            if st2["n"] == 1:
                await route.fetch()
                await route.abort()
            else:
                await route.continue_()
        await pg.route("**/payments", lose_pay)
        await pg.get_by_test_id("pay-handle").fill("cy")
        await pg.get_by_test_id("pay-amount").fill("7.00")
        await pg.get_by_test_id("pay-note").fill("")
        await pg.get_by_test_id("pay-submit").click()
        await expect(pg.get_by_test_id("pay-uncertain")).to_be_visible()
        s, _, raw = http("GET", "/_test/export")
        exp_doc = json.loads(raw)
        reset({"currency": "EUR", "minor_units": 2, "users": [U("zz", 1)]})
        s, _, _ = http("POST", "/_test/import", exp_doc)
        check("import 204", s == 204, s)
        await pg.get_by_test_id("pay-submit").click()
        await expect(pg.get_by_test_id("pay-uncertain")).to_have_count(0)
        s, b = api("GET", "/activity", token=tok("cy"))
        check("after import: retry recovers original, money once", sum(1 for x in b["payments"] if x["amount"] == 700) == 1 and await pg.get_by_test_id("pay-error").count() == 0)
        await pg.context.close()

        # 1280 overflow too
        pg = await new_page(1280)
        await login(pg, "ada")
        for route in ["/", "/requests", "/split", "/authorizations"]:
            await pg.goto(BASE + route)
            await pg.wait_for_load_state("networkidle")
            rep = await overflow_report(pg)
            check(f"1280 no overflow {route}", rep["worst"] is None and rep["sw"] <= rep["vw"], rep)
        # signup page
        await pg.get_by_test_id("logout-button").click()
        await expect(pg.get_by_test_id("login-email")).to_be_visible()
        await pg.goto(BASE + "/signup")
        await pg.get_by_test_id("signup-email").fill("New.Person@x.com")
        await pg.get_by_test_id("signup-password").fill("12345678")
        await pg.get_by_test_id("signup-display-name").fill("New P")
        await pg.get_by_test_id("signup-submit").click()
        await expect(pg.get_by_test_id("current-handle")).to_have_text("new_person")
        check("signup -> signed in, handle derived", await pg.get_by_test_id("current-user").text_content() == "New P")
        await pg.context.close()

        check("no external network requests", not external, external[:5])
        await browser.close()

    bad = [r for r in results if not r[0]]
    print(f"\n{len(results) - len(bad)} passed, {len(bad)} failed")


asyncio.run(main())
