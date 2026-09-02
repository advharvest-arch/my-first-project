# E2.2 PREP — End-to-End Latency Baseline

**Status:** E2.2_PREP_READY (instrumentation only).  
**Production routing:** UNCHANGED. `USE_WATER_GRAPH=false`.

## Goal

Answer: *why does the user wait, and how many ms does each segment consume?*

No optimization in this step.

## What shipped

| File | Role |
| --- | --- |
| `src/route-e2e-latency.ts` | E2E model, UI session, summary, ranking |
| `src/e2e-latency-bench.ts` | Dev/test baseline suite helper |
| `scripts/e22-e2e-baseline.ts` | `npm run bench:e22` |
| `src/route-trace.ts` | `trace.e2e` on every finish; `replaceLastRouteTrace` |
| `src/waterways.ts` | Graph shadow wall timed separately (`graphShadowMs`) |
| `src/main.ts` | UI BUILD ROUTE start → status seal |
| `src/user-test-panel.ts` | Shows E2E line in TEST ROUTE panel |
| `src/__tests__/e22-e2e-latency.test.ts` | Unit coverage |

## E2E definition

```
UI BUILD ROUTE / Проложить click
  → requestControl.begin
  → measureHybridChain → measureWaterChain
  → Phase A / B / C / Overpass / validator / hydro
  → emitDone (+ optional graph shadow)
  → setStatus(done|not found|error)
  → seal e2e.finishedAt
```

### Fields

```
e2e:
  startedAt, finishedAt, totalMs
  legacyRoutingMs          # totalMs − graphShadowMs
  stages: requestControlMs, endpointBindMs, phaseA/B/C,
          overpassMs, validationMs, hydroMs, finalizationMs
  counters: brouterCalls/hits/misses/deduped,
            phaseCTrials, overpassCalls/hits/misses
  graphShadowMs, graphShadowRan
  stagesOverlap: true
```

**Graph shadow is never treated as “acceleration”.** It is overhead only; default flag keeps it at 0.

## Overlap note (critical)

Stage timers are **not additive** to wall time:

- `brouterMs` ⊂ Phase B / Phase C walls
- Multiple Overpass cells race → `overpassMs` is **sum of call durations**, can greatly exceed E2E wall
- Phase A may succeed without bind/candidate buckets filling `endpointBindMs`

Use `totalMs` / `legacyRoutingMs` for user wait; use stage buckets for attribution.

## Live baseline (this environment)

Command: `npm run bench:e22`  
Flags: `USE_WATER_GRAPH=false`, early-stop off, long-span seg off.

| route | temp | E2E | legacy | br | A | B | C | op | val/hy | shadow | brCalls | hit/miss/dedup | net≈ | ok | reject |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---|---|
| VG-D | cold | 704 | 704 | 644 | 0 | 699 | 0 | 0 | 1 | **0** | 1 | 0/1/0 | 1 | Y | — |
| VG-mid | cold | 16645 | 16645 | 370 | 0 | 617 | 18 | **141351** | 0 | **0** | 3 | 0/3/3 | 0 | N | snap_empty |
| BELOMOR | cold | 365 | 365 | 352 | 0 | 365 | 0 | 0 | 0 | **0** | 1 | 0/1/0 | 1 | Y | — |
| N06 | cold | 3151 | 3151 | 113 | 23 | 3126 | 0 | 0 | 0 | **0** | 1 | 0/1/0 | 1 | Y | — |
| N08 | cold | 364 | 364 | 116 | 125 | 239 | 0 | 0 | 0 | **0** | 1 | 0/1/0 | 1 | Y | — |
| N11 | cold | 145 | 145 | 111 | 20 | 125 | 0 | 0 | 9 | **0** | 1 | 0/1/0 | 1 | Y | — |
| X3 | cold | 347 | 347 | 243 | 0 | 347 | 0 | 0 | 0 | **0** | 1 | 0/1/0 | 1 | Y | — |
| L01 | cold | **3** | 3 | 0 | 3 | 0 | 0 | 0 | 0 | **0** | 0 | 0/0/0 | 0 | Y | — |
| L01 | warm | **3** | 3 | 0 | 2 | 0 | 0 | 0 | 0 | **0** | 0 | 0/0/0 | 0 | Y | — |

Sample captured in agent environment via `npm run bench:e22` (network-dependent; re-run for fresh numbers).

### TOP-5 latency sources (sum of cold stage buckets, this sample)

1. **overpassMs — 141351** (VG-mid fail path; overlapping parallel cells ≫ wall)  
2. **phaseBMs — 5518**  
3. **brouterMs — 1949** (nested inside B/C)  
4. **phaseAMs — 171**  
5. **phaseCMs — 18**

### Graph shadow vs legacy

With production flag: **shadow = 0 ms**, **ran = false** on all rows.  
Legacy E2E ≡ total E2E.

### BRouter / dedup

- Successful short/medium corridors: typically **1** BRouter call (miss).  
- VG-mid failure: **3** calls with **3 deduped** shares (net≈0 additional unique keys beyond misses).  
- L01 open-lake: **0** BRouter calls (Phase A only).

## Recommendation (do **not** auto-optimize)

Analyze this baseline before picking **one** narrow next step. Likely candidates (for later decision only):

1. Overpass fan-out cost on mid/long fail paths (observability already shows overlap)  
2. Phase B wall ≈ BRouter RTT on success path  
3. Avoid treating shadow as speed work while flag is off  

**Do not implement optimizations in E2.2 PREP.**
