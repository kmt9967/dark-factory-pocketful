# FACTORY.md — a four-seat dark factory in BAND Desktop

This file is enough to stand the factory up and point it at a different problem. Nothing in `mandates/` names
this repository's product; everything product-specific lives in the single task message the human dispatches.

## 1. Goal

Turn one written task ("build X to this specification, in these stages") into released, container-verified code
with **no further human input**: the band plans, implements, reviews adversarially, verifies in a clean isolated
container, repairs its own defects, and reports.

## 2. Seats

| Seat | Harness | Model | Owns | Never does |
|---|---|---|---|---|
| **Architect** (lead) | Claude Code | `claude-opus-5-5` | reading the task, plan + numbered acceptance list, invariants, work items, every handoff, final report | write product code; accept on the author's word |
| **Implementer** | Claude Code | `claude-opus-5-5` | one scoped work item at a time: code, own tests, commit, handoff | accept its own work |
| **Reviewer** | Claude Code | `claude-opus-5-5` | adversarial review of the exact committed revision; own probe scripts; ACCEPT / REJECT with reproducible evidence | fix product code |
| **Verifier** | Claude Code | `claude-sonnet-5-5` | release gate: no-cache image build, supplied checks in isolated mode, reviewer probes, regression of earlier units; RELEASE / REJECT | fix product code; round a partial pass up |

Why four and not three: the guide's minimum is three, but we split *review* (does the code meet every spec
sentence?) from *release* (does the image build and pass in a clean, offline, resource-capped container, without
breaking earlier units?). They catch different failures, and a single reviewer that also has to run long Docker
builds tends to stop reading the spec carefully.

Why these models: the three reasoning-heavy seats (planning against a long spec, writing concurrent code,
finding counter-examples) use the strongest model available on our Claude plan; the verifier executes a fixed
procedure and reports numbers, so it runs on the cheaper, faster model.

## 3. Mandate philosophy

A mandate says **how a seat works**: what it owns, how it receives and hands off work, when it rejects, what
evidence it posts. It never says *what* is being built — no endpoints, field names, error codes, test ids or domain
words. Test we applied: *could a team building something completely different use these files unchanged?*
They are scanned before every run with the organisers' vocabulary list for both tracks (`harness check`), plus a
manual scan for domain words.

## 4. Task lifecycle

```
human ──(one task message)──▶ @architect
  @architect: confirm seats in room → read whole spec → commit PLAN.md (invariants, acceptance list, design, work items)
  for each unit (stage) in order:
     for each work item:
        @architect ──handoff (full spec pasted)──▶ @implementer ──commit + handoff──▶ @reviewer
        @reviewer ──REJECT + repro──▶ @implementer ──fix + regression test──▶ @reviewer … until ACCEPT
     @architect ──release handoff──▶ @verifier ──(no-cache build, isolated checks, probes, earlier units)
        REJECT ──▶ @implementer ──▶ @reviewer ──▶ @verifier … until RELEASE
     next unit = copy of released unit (no nested .git), extended
  @architect ──final report──▶ human
```

## 5. Handoff protocol

Seats only see messages addressed to them, so every handoff is **self-contained**: complete requirements pasted
(numbered parts, last marked FINAL), absolute repository path, folder, work item, acceptance criteria, commands,
and — from the implementer onward — the full commit hash. "See message X" is not a handoff. If a seat is absent,
the architect re-adds it and retries; it never substitutes another agent.

## 6. Rejection and recovery

- **Reviewer rejection** must cite the violated requirement and a reproducible request sequence; the implementer
  reproduces first, fixes the cause, adds a test that fails without the fix, and hands back a new revision.
- **Verifier rejection** carries the failing check, the kept output directory and a log excerpt; it re-enters the
  review loop, not a shortcut.
- Failing check directories are never overwritten or deleted, so every failure stays inspectable.
- If the band truly cannot proceed, the architect records the blocker and evidence as the outcome instead of
  asking the human — the human is not part of the loop.

## 7. Validation gates (in order)

1. Implementer's own tests + supplied checks (host mode).
2. Reviewer: acceptance-list walk, invariant attacks (concurrency, retries, malformed input, arithmetic edges,
   export/import), own probes for behaviour the shipped checks do not cover, "shaped to the tests" scan.
3. Verifier: clean tree at the exact revision, no nested `.git`/links/credentials, `--no-cache` build, health within
   limit, supplied checks in **isolated mode** (no outbound network, 2 vCPU, 2 GiB), reviewer probes against the
   container, earlier units still green, and the unit does not overshoot into the next suite.

## 8. Standing it up (≈ 30 min)

1. Install BAND Desktop, sign in, let it install the CLI and the Claude Code plugin; `band preflight` must be green.
2. Create four agents (or use **New local agent** in the app), each a headless Claude Code runtime whose working
   directory is the parent of your result repository, for example:
   `band agent create --name Architect --session architect --transport claude-code-cli --runtime-model claude-opus-5-5 --claude-permission-mode bypassPermissions --cwd <work dir>`
3. Load each mandate as the seat's standing instructions:
   `band agent instructions set --session architect --instructions-stdin < mandates/architect.md`
4. Create one room containing all four seats and yourself; post the task to `@architect`; send nothing else.
5. Download the room (console → Sessions → ⋮ → Download full session) as `room.json`.

## 9. Measured cost and time

Measured on the submitted run (room `33018a68-…`). Times are from room message timestamps (UTC). Cost comes from
`band usage rooms`, which is BAND's estimate at list prices, not a bill; the seats ran on a Claude subscription.

| Unit | Work items | Rejections | Released | Wall time |
|---|---|---|---|---|
| Stage 1 | W1 | 1 (Reviewer, 4 findings) | 21:40:25 | 1 h 08 m (from dispatch 20:32:50) |
| Stage 2 | W2a API, W2b UI | 1 (Reviewer, 2 findings) | 00:10:22 | 2 h 30 m |
| Stage 3 | W3a reads, W3b corrections | 1 (Reviewer, clock-floor finding) | 01:45:22 | 1 h 35 m |
| Stage 4 | W4a refunds, W4b batches | 0 | 02:46:33 | 1 h 01 m |
| **Total** | 7 work items | 3 | final report 02:47:25 | **6 h 14 m 35 s** |

| Seat | Estimated cost |
|---|---|
| Implementer (opus-5-5) | $32.45 |
| Reviewer (opus-5-5) | $18.17 |
| Architect (opus-5-5) | $6.72 |
| Verifier (sonnet-5-5) | $2.76 |
| **Room total** | **$60.09** (164,018,385 tokens) |

The two abandoned attempts and the rehearsal cost a further $9.80 together, and the smoke room cost $0.69.

Activity: 88 room messages, of which one was from the human (the dispatch). There are 28 seat commits on `main`:
Implementer 10, Reviewer 10 and Architect 8. The Verifier writes its evidence to the check directories and does
not commit. Shipped checks in isolated mode on a fresh clone, re-run by the operator after the run: stage 1
147/147, stage 2 35/35, stage 3 6/6, stage 4 5/5, giving `claimed stage: 4 on the shipped checks`, with every
`stage-N/` folder claiming its own stage.

## 10. What we tried that failed

Everything below happened before the submitted run; each fix is generic (mandate or seat configuration), never a
change to product code.

| When | What went wrong | Root cause | Generic fix |
|---|---|---|---|
| Rehearsal (toy task) | Every commit carried the same git author, so history could not show which seat did what | Seats share one machine and one git config | Mandates: commit with `--author "<Seat> <seat@band.local>"` |
| Rehearsal | A verdict was "sent" while a background build was still running; it arrived late with stale numbers | Seat ended its turn with work in the background | Mandates: run builds/checks in the foreground; never report a result you have not seen |
| Attempt 1 (18:09Z) | Implementer never started | A global MCP server on the host had the same name as BAND's own and shadowed it inside the seat | Seats re-created with `--claude-strict-mcp-config` (only BAND's MCP config is loaded); four-seat smoke room all READY |
| Attempt 2 (18:26Z) | Implementer finished its first work item and committed, but its report never reached the room; the band stalled | It answered with a *reply-to-message* tool; BAND holds such replies until turn end and dropped this one because the original message was marked "queued unrouted" for that seat. A runtime restart did not recover it | Mandates: every handoff/verdict/report goes out with the **direct send** command; read the room once to confirm it appears |
| Attempt 3 (20:32Z) | — | — | Submitted run. The first Implementer → Reviewer report arrived by direct send at 20:57:45Z, the point where attempt 2 died |

Attempts 1 and 2 were abandoned rooms with fresh result repositories; their partial repos are kept locally and
nothing from them was copied into the submitted run. The submitted run is one dispatch, in a fresh room, against an
empty repository containing only the mandates.

## 11. Known limitations

- All seats share one host and one Docker daemon (12 GB RAM machine); the mandates serialise image builds.
- Seats run with Claude Code `bypassPermissions` so the run is unattended; they should run on a machine you can
  throw away, or in Docker Sandboxes where the host supports them (not available on our Windows 10 host).
- The verifier can only run the *shipped* part of each suite; hidden-suite coverage depends on the reviewer's
  spec-driven probes.

- `room.json` contains four `error` events. Each one is BAND reporting that a background harness run by the
  Implementer exited with code 1, at 23:14, 00:30, 01:00 and 02:00 UTC. Each matches a run on a *partial* work item:
  stage-2 API-only, W3a twice and W4a. The next suite cannot pass yet on a partial item, so the harness exits non-zero
  (`checks/pf-s2-impl-3`, `pf-s3-impl-1/2` and `pf-s4-impl-1` show `highest contiguous stage` one below the target).
  The last work item of each stage then passed: `pf-s2-impl-4` claims 2, `pf-s3-impl-3` claims 3 and
  `pf-s4-impl-2` claims 4. Running these in the background goes against the mandate's "foreground checks" rule, which
  the Implementer did not always follow. The events are left in the export unchanged.
