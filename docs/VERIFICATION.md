# Operator verification (after the band finished)

Done by the human operator after the Architect's final report (02:47:25Z). Nothing in `stage-N/` was touched.

1. `git clone` of the result repository at HEAD `c3b7733` into a fresh directory.
2. `python -m harness run --track pocketful --repo <clone> --all --mode isolated` using the organisers' kickoff package
   `band-ai/dark-factory-wearedevs` @ `803560d`.
   - Isolated mode: no outbound network, 2 vCPU, 2 GiB.
   - One local patch, Windows host only: the test path passed to the Linux runner is POSIX-style (`harness/cli.py`, one line).

| Folder | Suite 1 | Suite 2 | Suite 3 | Suite 4 | Claims |
|---|---|---|---|---|---|
| stage-1/ | 147 passed | 1 failed (expected) | | | stage 1 |
| stage-2/ | 147 passed | 35 passed | 1 failed, 2 passed (expected) | | stage 2 |
| stage-3/ | 147 passed | 35 passed | 6 passed | 1 failed (expected) | stage 3 |
| stage-4/ | 147 passed | 35 passed | 6 passed | 5 passed | **stage 4** |

Harness output: `highest contiguous stage: 4` / `claimed stage: 4 on the shipped checks`.

The harness notes that the shipped checks are only part of the tests applied before judging.

The Verifier's own release-gate evidence, run during the band's work, matches these numbers. It is quoted in the
final report in `room.json`.
