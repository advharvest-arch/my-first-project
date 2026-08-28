# E2.2.1 — VG-mid fallback latency diagnostic

**Status:** DIAGNOSTIC ONLY. Production routing UNCHANGED. `USE_WATER_GRAPH=false`.  
**No optimizations** in this step.

## Verdict

**Immediate cause of ~16.6–16.9 s VG-mid E2E wait:** after Phase C `snap_empty` (~T+0.85 s), the legacy **Overpass `fetchWaterNetwork` cell-batch fallback** runs and **blocks on empty `cell_bbox` queries that take ~16 s each** (Overpass mirror race timeout). User wall time ≈ snap_empty + ~16 s Overpass batch wait. Final reject reason remains `snap_empty`.

Phase C itself is **~3–4 ms**. BRouter Phase B is **~0.8–0.9 s**. Neither explains the 16 s tail.

---

## A. Changed files

- `src/route-fallback-timeline.ts` (new)
- `src/route-trace.ts` — `fallbackTimeline` / summary attach
- `src/waterways.ts` — Overpass/Phase A/B/C/final markers; `clearWaterwayCellCacheForTests`
- `src/brouter.ts` — BRouter attempt markers
- `src/provider-cache.ts` — dedup markers
- `scripts/e221-vgmid-fallback-diag.ts`
- `src/__tests__/e221-fallback-timeline.test.ts`
- `docs/E2_2_1_VGMID_FALLBACK_DIAG.md` (this file)

## B. Commit

(see PR)

## C. Tests / build

- Unit tests green (incl. e221)
- Build OK
- Production algorithm / thresholds / Overpass timeouts **unchanged**

## D–E. Three VG-mid cold runs

| run | E2E wall | OP calls | BR calls | OP aggregate | OP wall | longest | snap_empty @ | final reject @ |
|---:|---:|---:|---:|---:|---:|---|---:|---:|
| 1 | **16892** | 43 | 6 | 182606 | **16033** | batch ~16002 | **866** | **16893** |
| 2 | **16945** | 43 | 6 | 199980 | **16033** | cell_bbox ~16012 | **917** | **16945** |
| 3 | **16832** | 43 | 6 | 199285 | **16012** | cell_bbox ~16008 | **826** | **16832** |

All: `ok=false`, `reject=snap_empty`, `overpassAggregateExceedsWall=true`.

## F. Compact timeline (VG-mid #1, condensed)

| start | end | duration | operation | parallel group | result |
|---:|---:|---:|---|---|---|
| 0 | 0 | 0 | request_start | — | start |
| 1 | 2 | 0 | phase_a | — | no_shared_lake |
| 2 | 982 | ~850–980 | phase_b (+ brouter http/dedup) | — | phase_b_fail |
| 863 | 866 | 4 | phase_c | — | snap_empty |
| 866 | 866 | 0 | snap_empty | — | snap_empty |
| 882 | 16883 | **16002** | overpass_batch / fetchWaterNetwork | overpass_batch_0 | batch_done / cells_ok |
| … | … | ≤16012 | many parallel `overpass:cell_bbox` | same batch | empty / ok_elements |
| 16893 | 16893 | 0 | final_reject | — | snap_empty |

Full event lists: `npx tsx scripts/e221-vgmid-fallback-diag.ts`.

## G. N08 / N06 sanity

| route | E2E | OP calls | BR calls | snap_empty | result |
|---|---:|---:|---:|---|---|
| N08 cold | 588 | **0** | 1 | none | **OK** (Phase B) |
| N06 cold | 3135 | **0** | 1 | none | **OK** (Phase B wall) |

Successful routes never enter Overpass fallback → no 16 s tail. Diagnostics work on success paths too.

## H. Clear conclusion

| Question | Answer |
|---|---|
| What creates ~16.6 s? | **Overpass cell-batch fallback after `snap_empty`**, waiting on empty cells for the full ~16 s query timeout |
| When does snap_empty appear? | **~T+0.83–0.92 s** (Phase C, ~4 ms) |
| When is final reject? | **~T+16.8–16.9 s** (still labeled `snap_empty`) |
| Why aggregate ≫ wall? | Up to **24 cells × 8-wide batches**, each racing mirrors; durations sum while wall = slowest in batch |
| Not the cause | Phase C trials (none — empty candidates); graph shadow (off); BRouter (~0.9 s) |

**Stop here — no optimization in E2.2.1.**
