# Pocketful — Stage 3 plan (Architect)

Spec: `stage-3.md`, extending `stage-2.md` and `stage-1.md` (all three pasted in full into every handoff).
Folder: `stage-3/`, created 2026-10-05 05:12 PST as a plain copy of released `stage-2/` (release revision b355029,
gated tree 8ca148f). `stage-1/` and `stage-2/` are frozen. Everything in `stage-1/PLAN.md` (I1–I8,
items 1–78, D1–D14) and `stage-2/PLAN.md` (I9–I13, items 79–121, E1–E12, E4a) still applies unless amended here.

## Invariants (in addition)

- I14 **Ledger identity.** For every user, at every (as_of T, known_at K):
  `total(T,K) = opening_balance + Σ amount(selected revision)` over that user's payments whose selected
  revision has `effective_at ≤ T`. The selected revision is the latest one with `recorded_at ≤ K`.
  `balance == total` and `available = total − held(T,K)`.
- I15 Current balance (no temporal params) == total(now, now). A correction moves the difference between the
  same two wallets in the same atomic step as appending the revision.
- I16 Σ total over all users == seeded total in every (T,K) view (each revision affects both parties equally
  and oppositely).
- I17 Revisions are append-only and immutable. Revision 1 = original amount, with
  `effective_at = recorded_at = created_at`. A payment's `recorded_at` values strictly increase. Original payment
  bodies and stored idempotent responses never change.
- I18 After any accepted correction, `total(b) ≥ 0` and `total(b) − held(b) ≥ 0` for both parties, at every
  boundary b ≤ now. Boundaries are the effective times of their payments and their hold event times, evaluated
  under the latest known revisions, with all movements at an instant combined.
- I19 A statement snapshot is immutable: paging it never changes balances or entries, whatever is written later.
  It lives until reset/import replaces state, and is carried through export/import.

## Architecture changes

- **Clock (W3a):** a strictly increasing server clock with millisecond resolution. Every call returns a value
  greater than the previous one (bumped by 1 ms when the wall clock has not advanced). All server-assigned
  instants use it: created_at, recorded_at, committed_at, capture and void event times, and the "read began"
  instant. A read therefore always sorts after every earlier write, and recorded_at strictly increases.
  Timestamps keep the existing `…sss+00:00` format.
- **Instant parsing (W3a):** a strict RFC 3339 parser. The pattern is
  `YYYY-MM-DDTHH:MM:SS(.fraction)?(Z|z|±HH:MM)`, with `T`/`t` accepted. The calendar date must be valid,
  hours 00–23, minutes and seconds 00–59, and the offset ±HH:MM within ±23:59. A fraction may have any number of
  digits. The value converts to an exact BigInt of epoch **nanoseconds**, used for every comparison so
  sub-millisecond client instants compare correctly. Naive times, bare dates and empty strings are rejected (422).
  Query strings are percent-decoded **without** turning `+` into a space: a raw `+` stays `+`, `%2B` is `+`.
  Echoed values (`as_of`, `known_at`) are the decoded string exactly as given.
- **Ledger model (W3a):** each payment gains `revisions: [{revision, amount, effective_at, recorded_at, reason}]`.
  Revision 1 is created with the payment. Each user gains `opening_balance`:
  - signup: 0;
  - reset: seeded balance − net of the seeded payments' original amounts (never validated as nonnegative,
    because earlier-stage fixtures must still load);
  - import from an older stage: current balance − net of all its payments.
  Seeded payments may carry `created_at` (RFC 3339 with offset; a future instant → reset 422; omitted → reset
  time). Their revision 1 uses it. Stored instants are kept as given strings plus their ns value.
- **Historical holds (W3a):** each authorisation records its lifecycle events: created_at; each capture
  (time, amount, final flag); and its close (final capture or void at event time, or expiry at `expires_at`).
  `held(T,K)` for an authorisation is 0 unless `created_at ≤ min(T,K)`. Otherwise it is amount − Σ captures
  with time ≤ min(T,K), and 0 if a close event with time ≤ min(T,K) exists or `expires_at ≤ T` (an expiry is
  known once the creation is known). Seeded open holds have created_at = supplied value, else reset time.
  Seeded closed holds hold nothing at any time. Authorisation views add `closed_at`: null while effectively
  open; the event time when captured or voided; `expires_at` when expired by the clock or seeded expired; and the
  reset time for seeded captured/voided holds.
- **Temporal reads (W3a):** `GET /me?as_of&known_at` and `GET /statement` (see the decisions below).
  Snapshots are stored per token in state as the fully computed window: entries, opening, closing, and
  the resolved from/to/known_at. Tokens are random and opaque, and scoped to their owner.
- **Corrections (W3b):** `POST /payments/{id}/corrections` (idempotent, the 8th path) and
  `GET /payments/{id}/revisions`. The historical check is a sweep over sorted boundaries with prefix sums
  per affected user.
- **Export/import:** still `format_version: 1`. The state adds revisions, opening balances, authorisation
  events/closed_at, snapshots and the clock high-water mark. Import accepts stage-1 and stage-2 exports and
  derives what they lack:
  - revision 1 of every payment from its created_at;
  - opening balances by the rule above;
  - capture events from the capture payments' created_at;
  - for a closed authorisation with no recorded close time (stage-2 voids), closed_at = its latest known event
    time (last capture time, else created_at). This is documented as best effort: it never overstates
    historical holds.
  On import the clock high-water mark is raised to at least the newest imported instant.

## Decisions (spec silent → conservative reading)

- G1 `GET /me` without `as_of`/`known_at` is exactly the stage-2 response (current corrected values). With either
  param: T = as_of or read-start, and K = known_at or read-start. All four money fields describe (T,K).
  Each supplied param is echoed exactly as given. An empty or invalid value of either param → 422.
- G2 Statement: `from` absent → −∞, with opening_balance = the user's opening balance. `to` absent → read-start.
  Half-open `[from, to)` on the selected effective_at. `from > to` → 422. `from == to` → no entries, with
  opening == closing. Entries: the caller's payments (sent or received; zero-amount revisions included) whose
  selected revision falls in the window. They are ordered by (effective_at ns, payment_id), with payment ids
  compared as plain code-unit strings. Each entry is `{payment, delta, balance_after, revision, effective_at,
  recorded_at}`. `payment` is the payment view with `amount` = the selected amount and everything else original.
  The response is `{opening_balance, entries, closing_balance, has_more, snapshot}`, plus `known_at` echoed when
  supplied (and `from`/`to` echoed when supplied). Any present `from`/`to`/`known_at` that is invalid → 422.
- G3 Snapshot: `snapshot` present together with any of `from`/`to`/`known_at` (even empty) → 422, checked
  before lookup. Unknown token, another user's token, or a token from before a reset/import → 404. A snapshot
  page returns the same shape as a first response, with the same token; only limit/offset apply.
- G4 Correction check order (consistent with D1/D2 and E1): 401 → body parse 400 → key 400/422 → replay/reuse
  → unknown payment 404 → caller is not the original sender 403 → body validation 422. Per the spec, *all*
  invalid input on this endpoint, wrong JSON types included, is 422. The fields: expected_revision a
  positive integral number, amount 0..1e9 integral, reason a string of 1..200 code points, effective_at
  RFC 3339 with offset and ≤ now. Then → settlement member or capture → 422 `linked_payment_immutable` → stale
  expected_revision (≠ latest) → 409 `stale_revision` → the current debit party's available < |difference|
  → 409 `insufficient_funds` → I18 violated → 409 `historical_overdraft`. A failure changes nothing and claims no key.
- G5 Correction response 201 `{payment_id, revision, amount, effective_at, recorded_at, reason}`. `effective_at`
  is echoed exactly as supplied; `recorded_at` comes from the server clock. Revisions are listed by
  `GET /payments/{id}/revisions` → `{"revisions":[…]}` in order, with revision 1 having `reason: ""`.
  401 without a token; 404 for an unknown payment or a third party, even when the payment is public.
- G6 `GET /activity` and every original receipt and replay keep the original payment body and amount.
  Corrections are not feed items.
- G7 Seeded payment `created_at` invalid (not RFC 3339 with offset) → reset 422. In the future relative to the
  reset instant → 422. Activity order uses created_at, so seeded payments without created_at sort as reset time,
  before later API payments.
- G8 New payment ids keep the existing scheme. Statement tie order is by id string as stated in G2; no id format
  change is required.

## Acceptance list (stage 3; every sentence of stage-3.md)

All stage-1 items 1–78 and stage-2 items 79–121 continue to hold.

### Payment timestamps
122. Every payment's created_at is RFC 3339 with an offset identifying when it moved money, on every endpoint
     returning a payment. /activity is still ordered by it.
123. A seeded payment may supply created_at. Omission → reset time, before later API payments. A future seeded
     created_at → reset 422 with no state change.
124. A fixture balance is still the post-payment balance. Loading seeded payments never changes balances.

### /me as_of
125. `as_of` is optional, RFC 3339 with offset. A naive time, bare date or empty value → 422. Without temporal
     params, the existing money fields with current corrected values.
126. With as_of: the balance after every payment with effective ≤ as_of (inclusive at exactly as_of) and before
     every later one. as_of ≥ latest payment → current balance. Before the earliest → the opening balance. as_of
     is echoed exactly.

### Statement
127. `GET /statement` with optional from/to (default: wallet opening / now) and limit/offset as /requests.
128. Payments the caller sent or received in [from, to), oldest first, each with delta (sent negative, received
     positive) and balance_after.
129. Ordered by effective_at (selected), then payment id ascending.
130. opening_balance = the balance immediately before from. closing_balance = the balance immediately before to.
     opening + Σ delta (full window) = closing.
131. Pagination never changes balance_after, opening or closing; they describe the full window.
132. Only the caller's own payments, even when other payments are public. Feed visibility rules do not apply.

### Effective vs recorded time, corrections
133. Every payment has a revision history. Revision 1 = original amount, effective = recorded = created_at
     (seeded: the supplied created_at, else reset time).
134. Opening balances = seeded ending balances − net of the original seeded payments. Corrections never change
     opening balances. New accounts open at 0.
135. `POST /payments/{id}/corrections` requires an idempotency key and the original sender. A non-sender → 403;
     unknown → 404. All fields are required, with the rules in G4. Invalid → 422.
136. A correction changes neither the parties nor the visibility. It appends an immutable revision and returns
     201 with payment_id, revision, amount, effective_at, recorded_at (server) and reason. Recorded times strictly
     increase per payment.
137. A stale expected revision → 409 `stale_revision`. A replay → 200 with that original revision, even after newer
     ones. Same key with a different body → 409 reuse.
138. The difference moves between the same two wallets atomically. An increase debits the sender; a decrease
     debits the receiver. A currently unaffordable debit → 409 `insufficient_funds`. Otherwise any negative
     corrected balance at any effective boundary (combined movements per instant) → 409
     `historical_overdraft`. A failure preserves balances, history, statements and idempotency. Σ balances =
     seeded total in every historical view.
139. The original payment and original idempotent responses stay unchanged. /activity shows the original
     payment. Corrections are not new feed payments.
140. `GET /payments/{id}/revisions` → `{"revisions":[…]}` in order, including revision 1 with reason "". Only
     the two parties may read it; a third party gets 404 (even for a public payment); no token → 401.
141. `known_at` on /me and /statement: per payment, the latest revision recorded ≤ known_at. If none is recorded
     yet, the payment contributes nothing. Omitted → everything known when the read begins. Selected revisions
     apply at their effective times. as_of stays inclusive; the statement window stays half-open. Both instants
     may be in the future. Invalid or empty → 422. A supplied known_at is echoed exactly.
142. Statement ordering is by the selected effective_at, then id. Each entry adds revision, effective_at and
     recorded_at. payment.amount = the selected amount. Zero-amount revisions are entries with zero delta. No
     correction is counted alongside the revision it replaces. With no corrections and no known_at, the result
     is as before.

### Stable statement pagination
143. Every first statement response returns an opaque `snapshot` token, freezing selected revisions, window,
     balances, entries and the default `to`.
144. `?snapshot=&limit=&offset=` pages that exact result even after payments or corrections. from/to/known_at
     together with a snapshot → 422. An unknown token, another user's token, or a token from before a reset →
     404. Tokens last until reset. The final partial page and offsets beyond the end report has_more correctly.
     Unknown params are ignored.
145. A correction may move a payment into or out of a window. Existing snapshots are unchanged by concurrent
     payments or corrections. Concurrent corrections with the same expected revision cannot both succeed.

### Settlement history and imports
146. Settlement members keep their receipts and privacy. The original revision uses committed_at as effective
     and recorded. A single-payment correction of a member → 422 `linked_payment_immutable`.
147. A stage-3 service imports stage-1 and stage-2 exports from our released services. The ledger accounts for
     authorisations and captures. A correction of a capture → 422 `linked_payment_immutable`.

### Historical holds
148. `/me?as_of=T&known_at=K`: all four money fields describe the same view; balance = total, available =
     total − held.
149. A hold starts at authorisation creation. A nonfinal capture reduces it at capture time. A final capture,
     void or expiry releases the remainder at that event's time. Expiry takes effect at expires_at.
     Non-expiry events are known at their server event time. Once the creation is known, the expiry is known.
     Beyond now, an open hold expires at its deadline. Without as_of, T = request start.
150. Authorisations expose `closed_at` (null while open; the event time when closed).
151. Historical total follows the effective/recorded rules. A correction that makes total OR available negative
     at any past effective/event boundary (latest known revisions) → 409 `historical_overdraft`. A current
     unaffordable debit still takes precedence as `insufficient_funds`.
152. Seeded open holds are created at reset unless created_at is supplied. Seeded closed holds need not
     reconstruct a lifecycle.
153. The statement contains money movements only. Authorisation, release and expiry are not entries. Captures
     appear exactly once with their links (authorization_id). Old snapshots are unchanged after any lifecycle
     action or correction.

### Stage discipline
154. `stage-3/` passes the stage 1–3 suites and must NOT pass the whole stage-4 suite: no refunds, no correction
     batches, no `refund_of` or `correction_batch_id` fields. RUN.md/Dockerfile name pocketful-s3. The UI
     keeps working; no stage-3 UI is required.

## Work items

- **W3a — temporal ledger reads:** strictly increasing clock; RFC 3339 ns parser and raw-`+` query decoding;
  revisions model (revision 1 only); opening balances; seeded payment created_at; authorisation lifecycle events
  and closed_at; `GET /me` as_of/known_at incl. historical holds; `GET /statement` with known_at and
  snapshots; export/import of the new state plus stage-1/stage-2 import derivation. Items 122–134, 141–144,
  148–150, 152–153 (with known_at selecting among revision 1 only), 147 (import part).
- **W3b — corrections:** `POST /payments/{id}/corrections`, `GET /payments/{id}/revisions`, the G4 order, the
  I18 historical check (total and available), linked-payment immutability, statement/known_at behaviour with
  multiple revisions, and snapshot immutability across corrections. Items 135–140, 145–147, 151 and 154.
- Verifier gate on the accepted W3b revision.
