# E2.2.3 — WaterGraph topology diagnostic (shadow only)

**Status:** DIAGNOSTIC ONLY. Production routing UNCHANGED. `USE_WATER_GRAPH=false`.  
**No seam edges. No connect thresholds. No graph-first accept path.**

## Question

What specifically prevents WaterGraph from being connected on VG-mid and Belomor?

## Answer (geometry / topology)

### VG-mid (Lower Volga mid, fixture `lower-volga-mid.geojson`)

| Component | lengthKm | waterId | role |
| --- | ---: | --- | --- |
| comp-0 | ~176 | `ww:волга` | Main stem (A→B bind on this component) |
| comp-1 | ~130 | `ww:ахтуба` | Parallel branch |
| comp-2 / comp-3 | ~8.6 / ~0.06 | `lock:dubna` / `lock:rybinsk` | **Remote** hardcoded locks (not Lower Volga) |

- **Waterway components in corridor:** 2 (Volga + Akhtuba).
- **Main gap:** Volga ↔ Akhtuba ≈ **14.5 km** (true min node distance).
- **Gap contents:** `nothing_known` (no mask / lake / lock in between).
- **Classification:** `TOPOLOGY_GAP` — different `waterId`s; same-water merge rules **intentionally** refuse to join them.
- **Corridor A→B:** both terminals bind onto **Volga**; Dijkstra can traverse the stem. Akhtuba is a side branch, not the mid-span tear.
- **What blocks “one corridor graph”:** (1) intentional non-merge of Volga vs Akhtuba; (2) no Lower Volga mask/fairway/lock layer; (3) remote Dubna/Rybinsk lock islands inflate `componentCount` without helping.

### Belomor (fixture `belomor.geojson`)

| Component | lengthKm | waterId |
| --- | ---: | --- |
| comp-0 | ~121.5 | `ww:беломорско-балтийский канал` (south/mid) |
| comp-1 | ~44.5 | **same** waterId (north tip) |

- **Gap:** ≈ **19.0 km** between ~63.95N and ~64.12N.
- **Gap contents:** `nothing_known`.
- **Classification:** `DATA_GAP` — same canal identity, **missing centerline geometry** in the fixture/ingest corridor.
- **Locks:** Belomor staircase **not** modeled; only Dubna/Rybinsk portals exist (remote noise). Knowledge layer may mention Belomor segment textually without portal coordinates usable as graph lock edges.
- **What blocks connectivity:** missing OSM canal centerline in the north tear + missing Belomor lock portals — not a failed Dijkstra on a connected graph.

### N06 / N08 (Kuibyshev, bundled mask)

- Large **mask** component (~400+ km mesh) + **fairway** fragment + remote locks.
- Sub-km **mask ↔ fairway** proximities appear as `TOPOLOGY_GAP` / seam candidates when seams do not merge them into one component.
- Legacy Phase A succeeds via lake mask; graph connectivity is a separate shadow concern.

### X3 (Cheboksary → Vetluga)

- Bundled Cheboksary mask is **incomplete** → no mask mesh.
- Graph ≈ regional fairway slice + remote locks; **no Vetluga waterway centerline** in ingest → effectively empty for the stem problem (`DATA_GAP` / missing data, not a classified pairwise tear inside scan radius).

---

## Deliverables

- `src/water-graph-topology.ts` — components, portals, diagnostic candidates, gap labels
- `trace.waterGraphTopology` on RouteTrace (filled when WaterGraph shadow runs)
- `scripts/e223-watergraph-topology.ts`
- `src/__tests__/e223-watergraph-topology.test.ts`

## Explicitly not done

- No “if dist < X connect”
- No production seam edges
- No `USE_WATER_GRAPH=true`
- No Overpass / BRouter / accept-reject changes

**Stop — choose next step after reviewing this report.**
