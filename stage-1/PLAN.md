# Pocketful — Stage 1 plan (Architect)

Spec: `reference/dark-factory-wearedevs/pocketful/spec/stage-1.md` (pasted in full into every handoff).
Folder: `stage-1/`. Run started 2026-10-05 01:32 PST.

## Invariants (must hold after every operation, under concurrency, retries, restarts of requests)

- I1 Sum of all wallet balances == sum of balances seeded by the last `POST /_test/reset` (or carried by the last import). (§1.1)
- I2 No balance is ever negative, not even transiently (no debit-then-check). (§1.2)
- I3 A request moves money at most once; a paid request has exactly one payment. (§1.3)
- I4 Every idempotent write takes effect at most once per (user, method, path, key); replays return the stored original body with 200. (§7)
- I5 A payment is in both wallets or neither; settlement members commit all-or-none. (§8, §11)
- I6 After reset/import returns, no earlier state (users, tokens, keys, payments) is observable. (§3.3, §10)
- I7 No 5xx under any input or load (50 in flight, 5 s budget). (§5, §2)
- I8 Amounts are exact integers; no float arithmetic beyond JS safe integers (±2^53). (§4)

## Architecture

- **Runtime:** Node.js 22 (alpine image), standard library only (`node:http`, `node:crypto`). No npm dependencies → nothing to fetch at runtime. Single process.
- **Storage:** in-memory state object (users, emails, handles, tokens, payments, requests, splits, settlements, idempotency records, id counters, currency). Disk state need not survive restart (§2).
- **Concurrency strategy:** every state read+mutation runs synchronously inside one event-loop tick (no `await` between check and write). Node's single thread therefore serialises all operations → linearisable; balance checks and debits/credits are atomic; concurrent identical idempotent requests see the first one's stored record and replay with 200. The only async work is password hashing (`crypto.scrypt`, libuv threadpool); uniqueness checks and inserts happen synchronously *after* the hash completes, against the current state object. A signup/login that began before a reset commits into the state object it captured, which is discarded (I6).
- **Reset:** validate the whole fixture first; hash all seeded passwords (async, parallel, salted scrypt with cost tuned so ~200 users reset well under 10 s on 2 vCPU); then swap in the new state object in one synchronous step. Any validation failure → 422 with old state untouched.
- **Export/import:** export = synchronous JSON serialisation of the whole state (atomic snapshot) wrapped `{track:"pocketful", format_version:1, state}`; import validates structure fully, then swaps synchronously. Tokens, password hashes, idempotency records (with original response bodies), counters, timestamps preserved verbatim.
- **Idempotency:** record key = `userId \u0000 method \u0000 path \u0000 key`. Stored only on success (2xx) together with canonical body (recursively key-sorted JSON) and response body. Resolution order is fixed (see decisions D1).
- **IDs:** prefix + counter (`u_`, `p_`, `rq_`, `sp_`, `st_`, tokens random 32 bytes hex), skipping any id already present (seeded ids may look like ours). ≤64 chars.
- **Timestamps:** server clock, RFC 3339 UTC with millisecond fraction and explicit `+00:00` offset; a monotonic counter keeps creation order stable (sequence number tie-break for "newest first").

## Decisions where the spec is silent (conservative reading)

- D1 Check order for idempotent POSTs: 401 auth → body parse (400 `malformed_request` if not a JSON object) → [settlements: 403 non-operator] → `Idempotency-Key` absent/empty 400 → length >255 422 → replay/reuse resolution (200 / 409) → field validation (400 wrong type / 422) → resource checks (404, 403) → state checks (409). Settlements: 403 is checked right after 401 (spec states it with the 401 rule).
- D2 Within one endpoint: field validation (422) → unknown handle/resource (404) → self (422 `self_payment`/`self_request`) → permission (403) → state (`request_not_pending`) → funds (`insufficient_funds`). For `/requests/{id}/pay|decline|cancel`: 404 unknown → 403 wrong caller (third parties too) → body validation → state → funds.
- D3 Wrong JSON type of a non-money field (e.g. `to_handle: 5`, `participant_handles: "x"`, an element of it not a string, `email: 1`) → 400. `amount` of any wrong type, `note` non-string (incl. null), any bad `visibility` → 422 (§5 overrides). `null` for other fields counts as wrong type → 400; missing required field → 422.
- D4 Settlements: anything about the batch shape (`transfers` missing / not an array / 0 or >32 items / an item not an object / item handle missing or not a string) → 422 `validation_failed`, entry errors in input order; per entry: field validation 422 → unknown handle 404 → self 422 `self_payment`; then collective affordability 409.
- D5 Email uniqueness and login match are case-insensitive on the whole address; stored as given. Valid email = exactly one `@`, non-empty local and domain, no whitespace. Password length and handle derivation count Unicode code points. `display_name` must be a non-empty string.
- D6 `POST /requests/{id}/pay` with an empty body is treated as `{}`. Decline/cancel ignore the body.
- D7 Unknown route → 404 `not_found`; known route with wrong method → 405 with error body (`method_not_allowed`). Body >1 MiB → 413 with error body.
- D8 Fixture invalid in any way (negative balance, non-integer amounts, bad/duplicate handle/email/id, unknown referenced user id in payments/requests/operators, minor_units ∉ {0,2,3}, bad status/visibility) → 422 `validation_failed`, state unchanged.
- D9 Seeded payments/requests get `created_at` = reset time; later fixture entries count as newer. Seeded paid requests have `payment_id: null`. Seeded payments have `request_id: null`, `settlement_id: null`.
- D10 Payment objects in stage 1 carry `settlement_id` (null for nonmembers) in addition to the §8 fields. No stage-2+ fields (`authorization_id`, `available`, …) appear in stage 1.

## Acceptance list (every requirement sentence; S = supplied checks exercise it, H = hidden/only-spec)

### §1 Scope
1. Sum of balances equals seeded total at all times, incl. concurrent/retried ops (H/S).
2. No negative balance ever, incl. concurrent overspend bursts (H).
3. A request pays at most once, incl. concurrent pay with different keys (H).
4. Amounts are exact integer minor units; money moves only between existing wallets (H).

### §2 Delivery
5. `stage-1/Dockerfile` builds with no manual setup; `RUN.md` gives the build+run command (S partially).
6. Image runs alone with `-e PORT=<port>` and a port mapping; no outbound network at runtime; all deps inside image (H isolated mode).
7. Healthy within 60 s; works within 2 vCPU / 2 GiB; 50 in-flight requests each < 5 s; reset < 10 s (H).

### §3 Runtime contract
8. Listen on 0.0.0.0:$PORT, default 8080.
9. `GET /health` → 200 `{"status":"ok"}`.
10. `POST /_test/reset` replaces all state, 204, no auth; repeated resets; subsequent requests see only the fixture (old tokens → 401).
11. JSON `application/json; charset=utf-8` on every response with a body.
12. Timestamps RFC 3339 with explicit offset.
13. Unknown body fields ignored; unknown query params ignored.
14. IDs opaque strings ≤ 64 chars.

### §4 Model
15. One currency + minor_units from fixture; returned on `/me`, payments, requests, splits.
16. Amounts `1000`, `1000.0`, `1e3` all accepted as 1000; booleans/strings rejected (422 for amount).
17. Handles unique, `^[a-z0-9_]{1,20}$`, immutable.
18. Signup handle derivation: local part → lowercase → non `[a-z0-9_]` chars → `_` → truncate to 20; taken → 409 `handle_taken`, no account created.
19. New users balance 0; can receive money and be asked for money immediately.
20. Payment is immediate and atomic; created directly or by paying a request.
21. Request lifecycle pending → exactly one of paid/declined/cancelled; only payer pays/declines; only requester cancels.
22. Request may exceed payer balance; paying while short → 409 `insufficient_funds`, nothing changes; same request payable later once funded.
23. Visibility chosen by payer at pay time; requests have no visibility and never appear in feeds.
24. Feed: payment visible iff public or caller is sender/receiver; no other rule.
25. `GET /requests` returns only requests where caller is requester or payer.
26. Splits are not feed items; their requests visible to their two parties; fulfilling payments follow feed rule.
27. Private payment hidden from third parties but visible to its receiver and sender, same `visibility` value for all.
28. amount ≤ 1000000000 per request; arithmetic exact.
29. Fixture format accepted (currency, minor_units, users, payments, requests, settlement_operator_ids); seeded users can log in immediately; balances are post-payment (no replay).
30. Negative seeded balance → 422 `validation_failed`, state unchanged.
31. minor_units 0/2/3 with EUR/JPY/BHD.

### §5 Errors
32. Every 4xx/5xx body `{"error":{"code","message"}}`.
33. 400 malformed_request for unparseable body / wrong JSON type; 400 missing_idempotency_key; 401 unauthenticated (missing/malformed/unknown token); 403 forbidden; 404 not_found; 409 idempotency_key_reuse; 422 validation_failed.
34. Correct-type invalid format/out-of-range → 422 (dates, negative counts, over-max, length).
35. Invalid amount (incl. strings/booleans), non-string note (incl. null), bad visibility → 422; omission → defaults.
36. Integer query params must be plain decimal digits: `1e9`, `4.0`, `+4` → 422.
37. Idempotency-Key 1..255 else 422; limit 1..200 else 422; offset ≥0 else 422.
38. No 5xx even under concurrent load.

### §6 Authentication
39. Signup 201 `{user_id, display_name, token}`; login 200 same shape.
40. Email taken 409 `email_taken`; password < 8 → 422; email not `local@domain` → 422; wrong password/unknown email → 401; derived handle taken → 409 `handle_taken`.
41. All other endpoints require bearer token except /health, /_test/reset, signup, login (and /_test/export, /_test/import per §10).
42. Tokens never expire; multiple concurrent valid tokens per account.
43. Passwords stored with a password-hashing function (scrypt), never plaintext (also not in export).

### §7 Idempotency
44. Five idempotent paths: POST /payments, /requests, /requests/{id}/pay, /splits, /settlements.
45. Key scoped per user; same key different users independent.
46. Replay = same user + method + path + body; same key/body on different path is a new request, succeeds normally.
47. Absent/empty → 400; first use → 201; replay → 200 with identical JSON body; different body → 409; key whose original failed 4xx is reusable as first use.
48. Body equality is JSON-value equality (key order/whitespace irrelevant).
49. Concurrent identical requests with unused key: exactly one 201, others 200 same body, effect once.
50. Replay returns original response even after the resource changed (e.g. request cancelled/paid); no further state change.
51. Claimed key resolved before field validation and resource checks: changed-to-invalid body with same key → 409.

### §8 API
52. `GET /me` returns user_id, display_name, handle, balance, currency, minor_units.
53. `POST /payments` 201 body with all listed fields (+ settlement_id null); note default "", visibility default public; request_id null.
54. Payments errors: insufficient 409, amount 422, self 422 `self_payment`, note >200 → 422, visibility 422, unknown handle 404.
55. Debit+credit atomic; failed payment leaves no trace (no feed item, no balance change, key not claimed).
56. Note stored verbatim (no trim/escape/normalise); Unicode/emoji byte-exact round trip; 200-char limit counts characters (code points).
57. `POST /requests` 201 body as listed; caller is requester; errors amount 422, self 422 `self_request`, note 422, unknown 404; payer balance not checked.
58. `POST /requests/{id}/pay`: only payer; body `visibility` optional default public; `{}` vs `{"visibility":"public"}` differ for replay; 201 payment with request_id; request becomes paid with payment_id.
59. Pay errors: not pending 409 `request_not_pending`; short 409 `insufficient_funds`; non-payer 403; unknown 404. Replay of success → 200 original even when already paid, no money moves, never 409 request_not_pending.
60. Decline: payer only, 200 with request declined; declining declined → 200; paid/cancelled → 409; non-payer 403.
61. Cancel: requester only, 200 cancelled; cancel cancelled → 200; paid/declined → 409; non-requester 403.
62. `GET /requests` filters direction (incoming/outgoing/absent), status (4 values/absent), limit (default 50, 1..200), offset (default 0, ≥0); unknown direction/status → 422; newest first; `has_more` correct; shape `{requests, has_more}`.
63. `POST /splits` 201 with split_id, amount, currency, note, shares (all participants incl. caller, given order, sum = amount), requests (every participant except caller, same order), created_at.
64. Split errors: amount 422, empty/duplicate participants 422, note 422, unknown handle 404. Caller-only split valid with `requests: []`. No balance checks. Zero share still creates a request.
65. `GET /activity` visible payments newest first, `{payments, has_more}`, limit/offset exactly as /requests.

### §9 Money and rounding
66. Shares whole units, sum to amount, differ by ≤1, extra units to first participants (table: 1000/3→334,333,333; 1/3→1,0,0; 10/3→4,3,3; 999/3→333×3; 5/5→1×5).
67. Different order → extra unit to different person; each split independent; after paying splits, total conserved.

### §10 Export and import
68. `GET /_test/export` 200 `{track:"pocketful", format_version:1, state:{…}}`, unauthenticated, atomic read-only snapshot unaffected by later writes.
69. `POST /_test/import` with that object → 204, atomic full replacement (not merge); repeated import restores without duplicating.
70. Invalid JSON → 400 per §5; missing fields / wrong track / wrong version / invalid state → 422 with destination unchanged.
71. Preserves accounts, hashed-password login, existing tokens, currency, balances, payments, requests, operator permissions, settlement membership, completed idempotency records and original responses; ids/timestamps not regenerated; failed keys remain reusable; old destination data and credentials removed; reset clears imported state.
72. No dependency on source process/files/port; works across separate containers.

### §11 Settlements
73. Fixture `settlement_operator_ids` (default []); operators may settle across any wallets but gain no access to others' requests/private items.
74. `POST /settlements`: no token 401; non-operator 403; idempotency key required (fifth path).
75. transfers 1..32; per entry ordinary amount/note/visibility rules and defaults; unknown handle 404; self 422 `self_payment`; malformed batch shape 422; entry errors in input order before funds; unknown fields ignored.
76. Affordable iff every wallet's resulting balance ≥ 0 (net, ordering-independent); else 409 `insufficient_funds`; all-or-nothing; failed validation claims no key, creates nothing.
77. 201 `{settlement_id, committed_at, payments}` in input order; each member an ordinary payment with `settlement_id`, `request_id: null`, `created_at == committed_at`; nonmembers `settlement_id: null`.
78. Members follow feed visibility; replays 200 with the original full response; reset/import preserve operators, payments, membership, retry responses.

## Work items

- **W1 (one pass, implementer):** complete stage-1 service in `stage-1/` — `Dockerfile`, `RUN.md`, source (`server.js` + small modules), covering acceptance items 1–78. Self-test locally with the supplied harness (host mode), then commit.
- Review (reviewer) of the exact revision against the full spec + this list; fix loop.
- Release gate (verifier): clean build, supplied checks in host and `--mode isolated`, wanted result `claimed stage: 1 on the shipped checks`, plus spot checks of hidden-spec behaviour.

Stage 1 is one coherent service (~1 k lines); splitting it would leave unreviewable half-states, so it is one work item reviewed in one pass.

## Amendments

- D11 (after W1 rev 2bd7c4b): a handle field that is a string but matches no user — including one that does not fit `^[a-z0-9_]{1,20}$` (e.g. `"BOB"`, `"no-such"`) — is 404 `not_found` ("No user has that handle"), not 422. Applies to `to_handle`, `payer_handle`, `participant_handles` entries and settlement `from_handle`/`to_handle`. An empty string is also 404 (no user has it).
