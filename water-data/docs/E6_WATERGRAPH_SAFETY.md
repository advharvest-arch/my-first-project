# E6 — WaterGraph safety validation

Read-only safety gate on the isolated E5 WaterGraph (`wg_nodes` / `wg_edges`) before any routing pilot.

**ALLOWED_TOPOLOGY ≠ navigable.** It only means no violation of fixed topology rules.

---

## Scope

| Do | Do not |
|----|--------|
| Integrity + E1 connection safety checks | Change canonical OSM / `routing_segments` |
| Classify edges ALLOWED / REJECTED / UNKNOWN | Integrate AquaRoute / BRouter / production flag |
| Belomor / VB gap / Volga–Akhtuba / N06–N08 / structures / Ladoga | Proximity/name seams, crossing joins, gap fill |
| Minimal `wg_safety_run` / `wg_edge_safety` layer | New graph topology layers |

DDL: [`db/init/014_watergraph_safety.sql`](../db/init/014_watergraph_safety.sql)  
Tool: [`ingest/e6_watergraph_safety.py`](../ingest/e6_watergraph_safety.py)  
Smoke: [`db/smoke/e6_watergraph_safety.sql`](../db/smoke/e6_watergraph_safety.sql)

```bash
python3 ingest/e6_watergraph_safety.py --json-out data/e6_watergraph_safety.json
docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/smoke/e6_watergraph_safety.sql
```

---

## Safety statuses (per edge)

| Status | Meaning |
|--------|---------|
| **ALLOWED_TOPOLOGY** | Integrity OK; E1 endpoints; matches `routing_segments` |
| **REJECTED_TOPOLOGY** | Integrity failure (should be 0 on a clean E5 build) |
| **UNKNOWN** | Topology OK but caution: structures and/or Ladoga ring membership — **navigability UNKNOWN** |

---

## Results (build_id from E5; fingerprint objects=455001)

### Categories

| Status | count |
|--------|------:|
| ALLOWED_TOPOLOGY | 158436 |
| UNKNOWN | 16737 |
| REJECTED_TOPOLOGY | **0** |
| total | 175173 |

### Graph integrity — PASS

Valid endpoints · no zero-length/invalid edges · 1:1 with `routing_segments` · provenance present · no deg-0 nodes · unique E1 keys.

### Connection safety — PASS

`rule_id=E1` · no tolerance · crossings do not create connections (2366 pairs; 2350 interior-only) · overlaps do not create connections.

### Regression cases

| Case | Decision |
|------|----------|
| Belomor 9909116 | **PASS** — 29 edges, 1 component |
| Volga–Baltic gap 53→54 | **PASS** — `would_E1_connect=false`, ~8.765 km, route through gap **not** allowed |
| Volga / Akhtuba | **PASS** — no synthetic sew; no shared E1 between named sets in this DB |
| N06 | **FALLBACK** — no WaterGraph coverage near terminals (Kuibyshev outside current extracts) |
| N08 | **FALLBACK** — same |
| Structures | **PASS** — lock/dam/weir/bridge/tunnel inventoried; navigability **UNKNOWN** (no auto PASS) |
| Ladoga | **PASS** — rings ≠ navigation centerline; membership = provenance |

---

## E7 readiness

**YES — can start an isolated E7 routing pilot** on corridors that already have graph coverage (e.g. Belomor / NW regional), with explicit constraints:

- No AquaRoute production flag / BRouter replacement in E7 without a further gate.  
- N06/N08 = **FALLBACK** until Kuibyshev (or required) extracts exist — **do not invent seams**.  
- Do not treat ALLOWED_TOPOLOGY or HIGH relevance as navigability.  
- Do not route through VB gap or unproven Volga↔Akhtuba joins.

---

## Invariants

canonical **455001 / 199570 / 92** · graph **203818 / 175173 / 62822** · sea-map unchanged.
