# Pocketful — Stage 4 plan (Architect)

Spec: `stage-4.md`, extending `stage-3.md`, `stage-2.md` and `stage-1.md`. All four are pasted in full into every handoff.
Folder: `stage-4/`, created 2026-10-05 06:46 PST as a plain copy of released `stage-3/` (release revision
07f0d29, gated tree c1a2c5f). Stages 1–3 are frozen. Earlier plans still apply in full unless amended here:
`stage-1/PLAN.md` (I1–I8, items 1–78, D1–D14), `stage-2/PLAN.md` (I9–I13, items 79–121, E1–E12, E4a) and
`stage-3/PLAN.md` (I14–I19, items 122–154, G1–G10).

## Invariants (in addition)

- I20 For every payment P: Σ amounts of refunds with `refund_of = P` ≤ P's current corrected amount (latest
  revision). Refunds and corrections both preserve this.
- I21 Refund payments and captures are immutable. They are never corrected, and refunds are never refunded.
- I22 Corrections in a batch are all-or-nothing. All revisions share one `recorded_at`, strictly later than every
  member's previous recorded_at. A rejected batch changes nothing (history, balances, idempotency).
- I23 Settlement membership never changes. Correcting any settlement member needs all members in one batch, with
  identical effective instants.
- I24 For any payment, `recorded_at` values strictly increase, including after importing an export from a source
  whose clock ran ahead. A new revision's recorded_at is max(clock tick, last recorded_at of that payment + 1 ms),
  and the clock is raised to it. This closes stage-3 review note N2.

## Architecture changes

- Refund payments are ordinary payments with `refund_of`, created through the same `makePayment` path
  (revision 1 at created_at). Every payment view gains `refund_of` (null unless a refund). Stored original
  responses are never rewritten.
- A per-payment refunded total is derived from the refunds of that payment, or cached and recomputed on import.
- The batch engine shares the single-correction code. It validates items in input order, then checks
  completeness, then applies all diffs to a scratch copy of the latest revisions. It checks current
  available per wallet on the net effect, then runs the I18 history check for every affected user under the
  combined revisions, then commits atomically (synchronously, in one tick).
- Revision objects gain `correction_batch_id` (null for revision 1 and for single corrections).
- Export/import: still `format_version: 1`. The state adds refund links and batch ids. Import accepts our stage-1,
  stage-2 and stage-3 exports, keeping settlement membership, corrections, snapshots and idempotency records. It
  validates I20 and refund-target rules (422, nothing changed).

## Decisions (spec silent → conservative reading)

- H1 Refund check order (same pattern as G4/E1): 401 → body 400 → key 400/422 → replay/reuse → unknown payment 404
  → caller is not the original receiver 403 → `amount` invalid (missing, wrong type, < 1, non-integral,
  > 1e9) 422 `validation_failed` → target is itself a refund 422 `invalid_refund_target` → Σ refunds + amount >
  current corrected amount 422 `refund_exceeds_payment` → receiver's available < amount 409 `insufficient_funds`.
- H2 The refund response is 201 with the payment view: from = the original receiver, to = the original sender, the
  original note and visibility, `request_id: null`, `authorization_id: null`, `settlement_id: null`,
  `refund_of: <target>`, created_at = now. Replay returns 200 with the original body. Refunds appear in the feed by
  the ordinary rule and in statements. A refund never changes a request, an authorisation, a hold or a settlement.
- H3 Single-correction order (extends G4): … → body validation 422 → target is a settlement member, capture or
  refund → 422 `linked_payment_immutable` → stale → 409 → new amount < Σ refunds of the target → 422
  `refund_exceeds_payment` → available → 409 `insufficient_funds` → 409 `historical_overdraft`. A new single
  correction's response adds `correction_batch_id: null`.
- H4 Batch order:
  - 401 → body 400 → non-operator 403 → key 400/422 → replay/reuse.
  - Batch shape 422: `corrections` missing, not an array, length 0 or > 32, an element not an object, or a duplicate
    payment_id among string payment_ids.
  - Items in input order: field validation 422 (payment_id must be a string; the correction fields follow G4) →
    unknown payment 404 → capture or refund 422 `linked_payment_immutable` → stale 409 `stale_revision` → new amount
    < refunded 422 `refund_exceeds_payment`.
  - Then settlement completeness 422 `incomplete_settlement` (for each settlement with any member present, every
    member must be present) → members of one settlement with different effective instants 422
    `validation_failed` (instants compared in ns) → combined current available per wallet 409
    `insufficient_funds` → combined history 409 `historical_overdraft`.
  - The operator need not be a party. Unknown fields are ignored.
- H5 The batch response is 201 `{correction_batch_id, recorded_at, revisions}` in input order. Each revision is
  `{payment_id, revision, amount, effective_at (as supplied), recorded_at (shared), reason, correction_batch_id}`.
  Replay returns 200 with the original batch response. The revisions endpoint shows batch revisions with their
  `correction_batch_id`.
- H6 Settlement members can be refunded singly (H1 rules). A refund does not make the member a non-member, and the
  refund itself is not a member (`settlement_id: null`).

## Acceptance list (stage 4; every sentence of stage-4.md)

All items 1–154 continue to hold.

### Refunds
155. `POST /payments/{id}/refunds` `{"amount"}` requires an idempotency key (the 9th path, §7 rules).
156. Only the original receiver may refund (else 403); an unknown payment → 404.
157. The target may be a direct payment, a request payment or a capture (and a settlement member, item 168), never a
     refund: a refund of a refund → 422 `invalid_refund_target`.
158. An invalid amount → 422 `validation_failed`. Cumulative refunds above the current corrected amount → 422
     `refund_exceeds_payment`.
159. A refund is a new payment in the opposite direction with `refund_of` = the target, `request_id: null`,
     `authorization_id: null`, and the original note and visibility. It returns 201; a replay returns 200 with the
     original body.
160. It moves money from the receiver's available funds atomically, or fails with 409 `insufficient_funds`.
161. Refunds never reopen a request or authorisation or restore a released hold. Other payments carry
     `refund_of: null`.

### Corrections with refunds
162. Stage-3 corrections stay available for ordinary direct and request payments.
163. Captures and refund payments cannot be corrected: 422 `linked_payment_immutable`.
164. A correction below the already-refunded amount → 422 `refund_exceeds_payment`.
165. Correction debits are checked against available funds.

### Batch corrections
166. `POST /correction-batches` requires a settlement operator (no token → 401; non-operator → 403) and an
     idempotency key (the 10th path).
167. `corrections` has 1..32 objects with distinct payment_ids, else 422. Every item has the ordinary correction
     fields and validation. An unknown payment → 404; a stale expected revision → 409 `stale_revision`.
168. The operator may correct ordinary, request and settlement payments. Captures and refunds stay immutable.
169. Correcting any settlement member needs every member of that settlement, else 422 `incomplete_settlement`.
     Members of one settlement need identical effective instants (offset spellings may differ), else 422
     `validation_failed`. Single-payment corrections stay available for nonmembers. Unknown fields are ignored.
170. Error precedence: item errors in input order → settlement completeness → resulting current available funds →
     historical total and available at every effective/event boundary. Codes are `linked_payment_immutable`,
     `refund_exceeds_payment`, `insufficient_funds` and `historical_overdraft`. Affordability is the combined effect
     of all proposed revisions. A rejected batch leaves history, balances and idempotency unchanged.
171. It returns 201 with `correction_batch_id`, `recorded_at` and `revisions` in input order. All new revisions share
     a recorded_at strictly later than each member's previous recorded_at. Each revision exposes
     `correction_batch_id`. Effective times are not later than now.
172. Original payments and receipts never change. Original payment and settlement retries return their original
     bodies. New statements reflect the new revisions. Earlier snapshots keep paging their frozen entries. Replays
     return the original batch response with 200.
173. A settlement payment may be refunded under the refund rules. Refunds never change settlement membership.
174. Concurrent corrections sharing any expected payment revision (single or batch, in any mix) cannot both succeed.
175. A stage-4 service accepts exports from our stages 1–3, keeping settlement membership, corrections and snapshots.

## Work items

- **W4a — refunds:** items 155–165 and 173, plus H1–H3, H6, I20, I21, I24 and the `refund_of` field everywhere.
- **W4b — correction batches:** items 166–172, 174 and 175, plus H4, H5, I22 and I23, and export/import of the new
  state.
- Verifier gate on the accepted W4b revision, followed by the final report.
