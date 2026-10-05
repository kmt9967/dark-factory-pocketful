# Dark Factory — Teqprotech · track: **pocketful**

WeAreDevelopers x BAND *AI Dark Factory (hackathon edition)* entry. A four-seat software factory in BAND Desktop
received **one task message** and built a wallet-and-payments service stage by stage — planning, implementing,
reviewing adversarially, verifying in a clean offline container and repairing its own defects — with no further
human input.

> **Read in 60 seconds:** [`FACTORY.md`](FACTORY.md) is the factory · [`mandates/`](mandates/) are the four
> generic seat mandates · [`room.json`](room.json) is the full BAND room the band worked in · `stage-N/` are the
> services it produced (each builds and runs alone) · the task we dispatched is quoted below.

## The factory

| Seat | Harness / model | Role |
|---|---|---|
| Architect | Claude Code · claude-opus-5-5 | plan, invariants, acceptance list, handoffs, final report |
| Implementer | Claude Code · claude-opus-5-5 | one scoped work item at a time, own tests, commits |
| Reviewer | Claude Code · claude-opus-5-5 | adversarial review with reproducible evidence; ACCEPT / REJECT |
| Verifier | Claude Code · claude-sonnet-5-5 | no-cache build, isolated offline checks, regression; RELEASE / REJECT |

Mandates are **generic**: they describe how each seat works and hands off, never what is built. They pass the
organisers' vocabulary scan for *both* tracks. Track detail lived only in the dispatched task.

## Results

**All four stages were released by the band, autonomously, in 6 h 14 m, at an estimated cost of $60.09** (BAND's
estimate at list prices, not a bill).

| Stage | What it adds | Shipped checks, isolated mode (offline, 2 vCPU, 2 GiB) | Released by Verifier (UTC) |
|---|---|---|---|
| `stage-1/` | payments, requests, splits, activity feed, settlements, export/import | 147 / 147 | 21:40 |
| `stage-2/` | holds and captures, browser UI | 147 + 35 / 35 | 00:10 |
| `stage-3/` | statements, as-of / known-at history, corrections | + 6 / 6 | 01:45 |
| `stage-4/` | refunds, batch corrections | + 5 / 5, **claimed stage 4** | 02:46 |

These numbers come from the operator's own re-run on a fresh clone after the band finished
(`python -m harness run --all --mode isolated`); each `stage-N/` claims its own stage. The shipped checks are only
part of the organisers' hidden suites.

Evidence of self-correction: the Reviewer rejected three revisions with reproducible findings. Each was fixed and
re-reviewed before the Verifier released it. Examples include a 0-amount capture of an empty hold, an import that
made available funds negative, and an import that pushed the server clock forward. The band's own open risks are
listed in the Architect's final report, the last message in [`room.json`](room.json).

Every `stage-N/` folder has its own `PLAN.md` (invariants, numbered acceptance list, decision log), `RUN.md`,
`Dockerfile`, source and `review/` probes. The service is Node.js 22 using only the standard library, with no
runtime network access.

**Demo video:** see the lablab submission. Slides are in [`media/dark-factory-slides.pdf`](media/dark-factory-slides.pdf).

## The only human input

The complete task posted once to `@architect` at **2026-10-04T20:32:50Z** (room `33018a68-5840-46db-80ca-bbf0a671347e`) is in
[`docs/DISPATCH.md`](docs/DISPATCH.md). Nothing was posted to the room after it.

## Reproduce

Each stage folder has its own `RUN.md`. In short:

```sh
cd stage-1 && docker build -t pocketful-s1 . && docker run --rm -e PORT=8080 -p 8080:8080 pocketful-s1
```

To grade like the organisers (from the kickoff package `band-ai/dark-factory-wearedevs`):

```sh
python -m harness check <this repo> --track pocketful
python -m harness run --track pocketful --repo <this repo> --all --mode isolated
```

## Who wrote what

- `stage-*/` — written only by the band in the BAND room (see commit authors and `room.json`).
- `mandates/`, `FACTORY.md`, `README.md`, `docs/` — written by the human operator, before dispatch (mandates) or
  after the run (documentation). No product code was written or edited by a human.

## License

MIT — see [`LICENSE`](LICENSE).
