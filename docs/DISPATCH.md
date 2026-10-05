# The only human input

Posted once by the human operator to `@architect` in BAND room `33018a68-5840-46db-80ca-bbf0a671347e` at **2026-10-04T20:32:50Z** (`band room send`). Nothing else was posted to the room by a human during the run. Verbatim text:

````text
@architect — Build the "pocketful" service, all four stages, in order, as a band. This message is the only human input for the whole run.

Result repository (absolute path, already initialised on branch main; commit only here, never elsewhere):
  F:\Hackathon\dark-factory-hackathon\band-work\pocketful-result
Stage folders: stage-1\, stage-2\, stage-3\, stage-4\ at the repository root.

Order of work:
1. Stage 1 in stage-1\ from scratch (any language/framework; a single container image).
2. When stage 1 is released, copy stage-1\ to stage-2\ (no nested .git, no links) and extend the copy to the stage 2 spec. Same for stage-3\ from stage-2\, and stage-4\ from stage-3\.
3. A stage folder solves its own stage, not a later one: stage-N\ must still pass every earlier suite and must NOT also pass the whole suite N+1. Earlier folders are never edited after they are released.
4. Every stage folder contains its source, a Dockerfile and a RUN.md that tells a stranger how to build and run it.

Specifications — read each one in full, and paste the complete text of the relevant one into every handoff:
  F:\Hackathon\dark-factory-hackathon\reference\dark-factory-wearedevs\pocketful\spec\stage-1.md
  F:\Hackathon\dark-factory-hackathon\reference\dark-factory-wearedevs\pocketful\spec\stage-2.md
  F:\Hackathon\dark-factory-hackathon\reference\dark-factory-wearedevs\pocketful\spec\stage-3.md
  F:\Hackathon\dark-factory-hackathon\reference\dark-factory-wearedevs\pocketful\spec\stage-4.md
Runtime limits from the spec apply: 2 vCPU, 2 GiB, up to 50 concurrent requests, 5 s per request, no outbound network at runtime.

Important: the supplied checks are only part of each stage's graded tests (stage 1 ≈ 79 %, stage 2 ≈ 35 %, stage 3 ≈ 9 %, stage 4 ≈ 16 %). The rest are hidden and every one of them is written in the specification. Build to the specification, never to the shipped tests; code shaped to the tests disqualifies the entry. A green shipped run is not evidence that a stage is done — review every spec sentence.

Supplied checks — run from F:\Hackathon\dark-factory-hackathon\reference\dark-factory-wearedevs (Docker is in "C:\Program Files\Docker\Docker\resources\bin" if it is not on PATH). Every --out directory must be new; number them and keep failing runs:
  .venv\Scripts\python.exe -m harness run --track pocketful --repo F:\Hackathon\dark-factory-hackathon\band-work\pocketful-result --stage N --out F:\Hackathon\dark-factory-hackathon\band-work\checks\pf-sN-<k>
Release check for each stage adds:  --mode isolated   (internal network, no outbound, 2 vCPU, 2 GiB)
Wanted result for stage-N\:  "claimed stage: N on the shipped checks". The shipped test files are in ...\pocketful\test\ — read them only to learn the harness contract, never to decide behaviour.

Machine note: this host has about 12 GB RAM shared by all seats and Docker; run only one image build or check at a time.

Run the full factory loop for every stage. When all four stages are released (or the run is blocked), post the final report and stop.

````
