# Pocketful — Stage 2 plan (Architect)

Spec: `reference/dark-factory-wearedevs/pocketful/spec/stage-2.md` plus everything in `stage-1.md`
(both pasted in full into every handoff). Folder: `stage-2/`, created at 02:41 PST on 2026-10-05 as a plain
copy of the released `stage-1/` (accepted revision 9984923, release gate run on tree 9bab33e).
`stage-1/` is frozen. Its plan (`stage-1/PLAN.md`: I1–I8, acceptance 1–78, D1–D14) **still applies in full**
except where this file amends it.

## Invariants (in addition to stage-1 I1–I8)

- I9 Σ wallet `total` == seeded total. Holds move no money; only payments, settlement members and captures transfer money. (A&C 1)
- I10 `available = total − held ≥ 0` at every read and after every write, including at the instant an
  authorisation expires. Held funds never fund payments, request payments, new authorisations or
  settlement net debits; a capture spends only its own hold. (A&C 2)
- I11 Σ captures of an authorisation ≤ its amount. Each idempotent capture moves money once. A closed
  authorisation (captured / voided / expired, by status or by clock) never moves money again. (A&C 3)
- I12 Concurrent operations are equivalent to some serial order (stage-2 "Concurrent operations").
  This is still guaranteed by synchronous check+mutate in one tick.
- I13 Expiry is a function of the clock: any read or write at time t treats an open authorisation with
  `expires_at ≤ t` as `expired` with zero hold, even if no request arrived at the deadline.

## Architecture changes

- **Server (W2a):** add `authorizations` to state (id, from, to, amount, captured_amount, payment_ids[],
  note, visibility, stored status, expires_at, created_at), plus `authorization_ttl_seconds` from the fixture.
  `effectiveStatus(a, now)` = stored status, but `expired` if it is stored `open` and `expires_at ≤ now`.
  `held(user, now)` = Σ (amount − captured_amount) over that user's effectively-open outgoing authorisations.
  It is computed on demand (O(n) is fine at this scale) or kept as a cache that is re-validated against
  `now`. It must never be a stale counter that misses an expiry. Every stage-1 funds check now
  uses `available`. Every payment view gains `authorization_id` (null unless the payment is a capture).
- **UI (W2b):** a single-page or server-rendered UI served by the same Node process, with no external
  assets (system font stack, inline CSS/JS, no CDN). It calls the JSON API with `fetch`, and the bearer
  token is kept in `localStorage` so a session survives export→import. Content negotiation: for
  `GET /requests` and `GET /authorizations`, an `Accept` header containing `text/html` gets HTML;
  anything else gets the JSON API. `GET /`, `/split`, `/signup` and `/login` always get HTML. API POST
  routes are unchanged. Static assets live on paths the API does not use (e.g. `/assets/app.js`,
  `/assets/app.css`), or are inlined.
- **Export/import:** still `format_version: 1`. The state gains `authorizations` and
  `authorization_ttl_seconds`. Import accepts a stage-1 export (no `authorizations`, so empty; ttl
  defaults to 600) and preserves tokens, idempotency records and original response bodies verbatim
  (stage-1 payment bodies stay without `authorization_id` when replayed).

## Decisions (spec silent → conservative reading)

- E1 Capture check order, consistent with stage-1 D1/D2 for `/requests/{id}/pay`: 401 → body parse (400) →
  key absent 400 / >255 422 → replay/reuse (200/409) → field types (`final` present and not boolean, including null,
  → 400) → unknown authorisation 404 → caller is not the receiver 403
  (non-parties included) → `amount` (if present) of wrong type, < 1, non-integer or > 1e9 → 422 `validation_failed` → stored status not open
  (captured/voided/expired) → 409 `authorization_not_open` → clock-expired (`expires_at ≤ now`) → 409
  `authorization_expired` → amount > remaining → 422 `capture_exceeds_authorization`.
- E2 Void: 404 → 403 (anyone other than the payer, receiver included) → stored `voided` → 200 current;
  stored captured/expired or clock-expired → 409 `authorization_not_open`; open → voided, hold released.
  A partially captured open authorisation can be voided; only the remainder is released.
- E3 `POST /authorizations` follows `POST /payments` exactly: same field rules, D2 order, D11 handle
  404, then `available < amount` → 409. `expires_at = created_at + ttl` exactly; both are emitted in
  the same RFC 3339 form.
- E4 Fixture `authorizations[]`: id (string, unique among authorisations), from/to user ids existing
  and distinct, amount 1..1e9 integer, note string ≤200 (default ""), visibility (default public),
  status ∈ {open, captured, voided, expired}, `expires_at` an RFC 3339 instant with offset (required).
  Optional `captured_amount` (integer 0..amount; defaults to `amount` for `captured`, else 0),
  `payment_ids`/`payment_id` (default none/null), and `created_at` (default reset time). Seeded holds
  that are open and unexpired at reset time count toward the per-user sum check (> balance → 422).
  `authorization_ttl_seconds`: when present, it must be an integral number > 0 (JSON 600.0 accepted,
  booleans and strings rejected), else 422. Any invalid entry → 422 with no state change.
- E5 `remaining_amount` = amount − captured_amount while effectively open; 0 when closed.
  `payment_id` = the latest capture (null if none); `payment_ids` = all captures in order.
- E6 The capture payment's `created_at` is the capture time; it is a normal payment for feed and visibility,
  with `request_id: null`, `settlement_id: null`, and `authorization_id` set.
- E7 Settlement affordability: for each wallet, `total + net − held ≥ 0` (net debit funded only by available).
- E8 UI amount parsing: input is trimmed of surrounding whitespace and must match
  `^\d+(\.\d{1,mu})?$` (for mu = 0: `^\d+$`); `15.` and `.5` are rejected. The value must be ≥ 1
  minor unit for pay/request/authorise (splits: ≥ 1 as well) and ≤ 1e9, else the form's error
  element is shown and nothing is sent. Server refusals are shown in the same error element.
- E9 UI idempotency: each form keeps `{key, bodyJSON}`. On submit, if the body is identical to the last
  attempted body, reuse the key; otherwise mint a new key. A 4xx refusal keeps the key (the server
  treats a failed key as unused). Success keeps the form values and the key, so an unchanged
  resubmit becomes a replay (200, no new money) and the UI shows no error. A lost response (network
  error, timeout, 5xx, aborted fetch) shows `pay-uncertain` and keeps key and body. The same approach
  applies to request, split, authorise and capture forms.
- E10 Latest refresh wins: every data load carries a monotonically increasing sequence number, and a
  response is applied only if its sequence ≥ the last applied sequence for that view. After a refused
  payment, the UI refreshes balance and feed and preserves the inputs.
- E11 Unauthenticated visits to an app route redirect (client side) to `/login`. A 401 from the API
  clears the token and goes to `/login`. Logout clears the token locally (there is no server logout
  endpoint in the spec, so none is added).
- E12 Navigation (header on every signed-in screen): Wallet `/`, Requests `/requests`, Split `/split`,
  Holds `/authorizations`, plus `current-user`, `current-handle` and `logout-button`.

## Acceptance list (stage 2; S = shipped checks touch it, H = hidden/spec-only)

All stage-1 acceptance items 1–78 continue to hold (regression run of stage-1 probes and suite).

### Screens and negotiation
79. Routes `/`, `/requests`, `/split`, `/signup`, `/login` are reachable by URL; other screens (the
    `/authorizations` route) are reachable through the UI as well as by URL.
80. `/requests` and `/authorizations`: `Accept: text/html` gets the UI; no such header gets the JSON API (unchanged).
81. All required `data-testid` attributes are present with the exact semantics listed (signup, login,
    auth-error present only on error, current-user on every signed-in screen containing display name,
    current-handle exact handle text, logout-button).

### Product and visual quality (H — graded by humans/agents)
82. Coherent, calm, trustworthy consumer finance look; available funds are the most prominent money value;
    total and held are secondary.
83. Payments, requests, splits and authorisations are scannable. Direction (sent/received), privacy,
    status and money movement are understandable without raw API data (e.g. "You paid @bob", a private
    badge, status chips).
84. A consistent visual system (type scale, spacing, colour tokens, controls, feedback). Primary actions are obvious.
    Available, held, pending, loading, success, refused and uncertain states are visually distinct.
85. People, amounts and timestamps are formatted for humans (display names/handles, formatted money,
    readable dates). Raw ids appear only where useful.
86. Usable at 375 px width and at desktop widths with no horizontal page scroll. Visible labels for all inputs,
    visible keyboard focus, sufficient contrast.
87. Considered empty, loading and error states. Consistent navigation across required routes. No external
    fonts or scripts.

### Wallet `/`
88. `wallet-balance` text exactly the formatted total (`100.00 EUR`, `1200 JPY`, `1.500 BHD`) with `data-amount` = minor units.
89. The pay form has the specified testids. `pay-visibility` option values are `public`/`private`. Decimal input → minor units
    (`15.00`/`15` → 1500, `15.5` → 1550). Nonnumeric input or too many decimals (`15.005`) shows `pay-error` and sends nothing.
90. After success the form keeps its values. An unchanged resubmit sends no new payment: the balance falls once, the feed has
    one payment and `pay-error` is absent. Changing a field makes the next submit a new payment.
91. Request form with `request-error` on refusal, using the same decimal rules.
92. Activity feed: `activity-list` children newest first. `activity-item-{id}` has `data-visibility`.
    `activity-parties-{id}` contains both handles. `activity-amount-{id}` is exactly the formatted amount.
    `activity-note-{id}` is exactly the note and is present even when empty. `empty-activity` replaces the list when
    nothing is visible.
93. After any successful action, the balance, feed and request lists on the page show the new state without a
    manual reload. The refresh waits for the write to succeed.

### Requests `/requests`
94. `incoming-list` and `outgoing-list` are present. `request-item-{id}` has `data-status`. `request-amount-{id}` shows the
    formatted amount. Pay and decline buttons appear only on pending incoming requests; cancel appears only on pending
    outgoing requests. `request-error` appears on refusal. `empty-requests` appears when both lists are empty.
95. A request cancelled elsewhere: pay is refused, the UI shows `request-error` and refreshes the list, and the stale pay
    button disappears.

### Split `/split`
96. `split-amount` uses the decimal rule. `split-handles` takes comma-separated handles in order (whitespace around
    handles is trimmed). There are `split-note` and `split-submit`. `split-preview` shows a
    `split-share-{handle}` for every participant, computed by the §9 rule before posting, and identical to the
    server's shares. `split-error` appears on refusal.

### Competing clients and uncertainty
97. `wallet-refresh` reloads the balance and feed without clearing the pay form. The latest refresh wins even when
    responses arrive out of order.
98. A refused payment (spent elsewhere) shows `pay-error`, refreshes the balance and feed, and keeps all pay inputs.
99. A lost payment response (including after commit) shows nonempty `pay-uncertain` and not `pay-error`. The unchanged
    form retries with the same key and body. A successful retry removes both elements, refreshes, and moves money once.
100. No polling or live sync is needed. The same refresh rules apply to available and held.

### Upgrade
101. A stage-2 service imports a stage-1 export from our stage-1 service. A browser signed in before stays signed in
     (its token stays valid and is still in localStorage). Pending requests stay payable via `/requests`.
102. A payment whose response was lost before the export is retryable after import with the same key and body, and the UI
     recovers the original payment and refreshes the imported balance. The form and the pending retry identity survive
     (no reload needed).

### Authorisations and captures (API)
103. I9–I11 hold under concurrency.
104. `GET /me` adds `total` (== balance) plus `available` and `held`. With no holds, everything is as in stage 1.
105. `POST /payments` stays immediate (no hold). Every `insufficient_funds` (payments, request pay, settlements) uses
     `available`.
106. Splits are unchanged. Paying a request is immediate. There is no request authorisation.
107. There are seven idempotent paths, adding `POST /authorizations` and `POST /authorizations/{id}/capture`, each with
     the §7 rules.
108. Fixture `authorization_ttl_seconds` (default 600, positive integer, else 422) and `authorizations[]` (may be omitted).
     `available` is derived. A seeded unexpired open hold sum > balance → 422 with nothing changed. Seeded statuses are
     open/captured/voided/expired, and only open holds money.
109. `expires_at ≤ now` means `expired` with no hold, reflected in `GET /authorizations` (status `expired`) and in
     `GET /me` `available` without any request at the deadline.
110. `POST /authorizations` returns 201 with the exact shape (plus `remaining_amount` and `payment_ids`), and
     `expires_at = created_at + ttl`. Errors: available < amount 409, amount 422, self 422 `self_payment`, note or
     visibility 422, unknown handle 404. Open authorisations never appear in `/activity`.
111. Capture: receiver only. Optional `amount` defaults to the remainder. `{}` and `{"amount":N}` differ for replay.
     Returns 201 with the payment shape, with `authorization_id` set and `request_id` null. The amount is the captured
     amount, and the note/visibility are copied from the authorisation. It appears in the feed by the ordinary rule.
     Non-capture payments have `authorization_id: null`.
112. A default (final) capture sets status `captured`, sets `captured_amount` and `payment_id`, and releases the
     remainder in the same step. A second capture after a final one → 409 `authorization_not_open`.
113. Extended mode `final: false` (boolean, default true): the status stays open while there is a remainder, so more
     captures are allowed up to it. Capturing the entire remainder closes it. A final capture closes and releases.
     `capture_exceeds_authorization` compares against the remaining amount. `captured_amount` is cumulative,
     `payment_id` is the latest capture, `payment_ids` lists all captures, and `remaining_amount` appears on every
     authorisation response (0 when closed). Void or expiry closes a partial authorisation, releases only the remainder,
     and keeps the capture records. New fields do not change idempotency body equality.
114. Capture errors: not open 409, expired 409 `authorization_expired`, exceeds 422, amount < 1 or non-integer 422,
     non-receiver 403 (including non-parties), unknown 404.
115. Void: payer only (403 for anyone else, including the receiver and non-parties). 200 voided with the hold released.
     Voiding again → 200 with the current state. Captured or expired → 409 `authorization_not_open`. No key needed.
116. `GET /authorizations` returns only authorisations involving the caller, newest first. Filters: direction
     outgoing/incoming, status (4 values; a clock-expired authorisation matches `expired`, never `open`),
     limit/offset/has_more as in /requests, with the same 422 rules.

### Authorisations (UI) `/authorizations`
117. `wallet-balance` = total. `wallet-available` (the headline) has `data-amount`. `wallet-held` has `data-amount` and
     is absent when held is 0. Seeded holds are reflected immediately after reset.
118. Authorise form testids, with the pay-form input rules. `authorize-error` appears on refusal, including insufficient
     available.
119. `authorization-list` children are newest first. `authorization-item-{id}` has `data-status`.
     `authorization-amount-{id}` shows the formatted authorised amount. `authorization-captured-{id}` appears only when
     captured. `authorization-expires-{id}` contains the RFC 3339 `expires_at` text exactly. On incoming open
     authorisations only: `authorization-capture-amount-{id}` (prefilled with the remaining amount as a decimal) and
     `authorization-capture-{id}`. On outgoing open authorisations only: `authorization-void-{id}`.
     `authorization-error` appears on refusal. `empty-authorizations` appears when the list is empty.

### Concurrency
120. Concurrent requests serialise. Every requirement holds at every read.

### Stage discipline
121. `stage-2/` passes the stage 1 and stage 2 suites and must not pass the whole stage 3 suite. It has no statements,
     corrections or `as_of`. `stage-2/RUN.md` and `stage-2/Dockerfile` are updated (image name `pocketful-s2`).

## Work items

- **W2a — API (server only):** items 103–116 and 120, plus E1–E7 and stage-1 regressions. Payments carry
  `authorization_id`. Export/import accepts stage-1 exports. No UI. Reviewed alone.
- **W2b — UI:** items 79–102, 117–119 and 121, plus E8–E12, on top of the accepted W2a. Reviewed alone,
  including in a real headless browser at 375 px and 1280 px.
- Verifier gate on the accepted W2b revision: stage-1 and stage-2 supplied suites, host and isolated.
