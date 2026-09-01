# E4.5 — WaterGraph topology rules (specification + measured PoC)

**READ-ONLY.** Formalizes how `water.routing_segments` *could* become a future topology graph.

Does **not** create `graph_nodes` / `graph_edges`. Does **not** mutate canonical data or `routing_segments`. Does **not** claim navigability.

Measured PoC: [`ingest/e45_topology_rules_audit.py`](../ingest/e45_topology_rules_audit.py)  
Smoke: [`db/smoke/e45_topology_rules.sql`](../db/smoke/e45_topology_rules.sql)  
Prior evidence: [E4.4 topology inference](E4_4_TOPOLOGY_INFERENCE.md)

---

## Design principles

1. **Member ways / linear segments = geometry SoT** (E3.15 / E4.3).  
2. **Endpoint identity first**; tolerance is diagnostic, not a stitcher.  
3. **Crossing ≠ junction.** Tags/semantics required before any connection claim.  
4. **Relation membership = provenance**, not an edge.  
5. **Relevance / candidate / segment ≠ navigable.**  
6. Unresolved gaps stay unresolved (no synthetic seams).

---

## A. Endpoint connection

### Proposed rules

| Rule ID | Condition | Topology effect (future) | Status |
|---------|-----------|--------------------------|--------|
| **E1** | Exact endpoint match (lon/lat rounded to 7 decimals, ~1 cm) | **Allowed connection candidate** between segment ends sharing that location | **Recommended primary** |
| **E2** | Snap tolerance **1 m** (EPSG:3857 diagnostic grid) | Near-duplicate of E1 in this DB; optional QA band for float noise | Proposal: review-only unless exact fails due to precision |
| **E3** | Tolerance **5 m** | **Not** an automatic edge; unresolved candidate for manual/tag review | Diagnostic only |
| **E4** | Tolerance **10 m** | **Not** an automatic edge; same as E3 | Diagnostic only |

### Measured (fingerprint objects=455001)

| Mode | unique endpoints | connected (deg≥2) | isolated | junction cand (deg≥3) | segs w/o connection |
|------|-----------------:|------------------:|---------:|----------------------:|--------------------:|
| exact | 203818 | 119266 | 84552 | 2466 | 46712 |
| 1 m | 203816 | 119265 | 84551 | 2467 | 46712 |
| 5 m | 203697 | 119173 | 84524 | 2562 | 46698 |
| 10 m | 203255 | 118906 | 84349 | 2901 | 46596 |

**Proposal:** use **exact (E1)** as the only rule that may create a topology adjacency in a future builder. Treat 1/5/10 m as **measured tolerance bands**, not connection proofs.

**Explicit:** tolerance does **not** prove navigability, shared waterbody, or legal passage. It only clusters coordinate locations for diagnostics.

---

## B. Junctions

### Proposed rules

| Rule ID | Condition | Effect |
|---------|-----------|--------|
| **J1** | Endpoint cluster degree ≥ 3 | **Junction candidate** (not a graph node yet) |
| **J2** | Degree = 2 | Ordinary through-connection candidate (if E1) |
| **J3** | Degree = 1 | Dead-end / unconnected end (may be extract boundary or true isolate) |
| **J4** | Geometric crossing alone | **Does not** create a junction (see C) |

### Additional checks required before promoting J1 → real junction

1. All incident segments share a waterway/network context (same HIGH waterway relation membership **or** explicit shared node identity) — still not navigability.  
2. No conflicting `layer` / `bridge` / `tunnel` / `location` semantics that imply grade separation.  
3. Structures (lock/dam/weir) at the same cluster flagged for navigation policy (E), not auto-passable.  
4. Human or later policy review for degree ≥ 4 (rare; 132+ clusters at exact).

Measured exact degree distribution: 1→84552 · 2→116800 · 3→2332 · 4→132 · 5→2.

---

## C. Crossings

Measured global intersecting pairs: **150298**  
· proper crossings (`ST_Crosses`): **2366**  
· touches_only: **147778**  
· overlaps: **126**  
· other: **28**

| Class | May create topology connection? | Tags / semantics needed | Unresolved when |
|-------|--------------------------------|-------------------------|-----------------|
| **touches_only** | Only if contact is at **endpoints** already covered by **E1** | None beyond endpoint identity | Touch mid-edge without shared node (should be rare; verify) |
| **proper crossings** | **No** by default | Need explicit junction feature, shared node, or waterway junction tagging; check `layer`/`bridge`/`tunnel`/`location` | Cross under/over, cartographic artifact, missing tags |
| **overlaps** | **No** by default | Duplicate mapping / dual centerlines — needs OSM cleanup or keep_canonical policy | Parallel duplicates, import conflicts |

**Rule C1:** `ST_Crosses` ⇒ classify as `CROSSING_UNRESOLVED` until tags or shared-node evidence exist.  
**Rule C2:** Never invent a junction geometry at the crossing point in E4.x.

---

## D. Bridges / tunnels / culverts

### Measured tag inventory (`routing_candidates`)

| Signal | candidates | notes |
|--------|----------:|-------|
| `bridge=*` (non-empty / yes-ish) | 19 | `yes` 13, `aqueduct` 6 — **sparse** |
| `tunnel=*` (not no) | 5946 | mostly `tunnel=culvert` (5606), `yes` 318 |
| culvert signal (`tunnel=culvert` / related) | 5632 | almost all via tunnel=culvert |
| on linear `routing_segments` | bridge 19 · tunnel 5937 | |

### Proposed influence (data-limited)

| Rule ID | Proposal |
|---------|----------|
| **BT1** | If segment has `bridge=*` or `tunnel=*` (incl. culvert), **do not** treat a proper crossing with another segment as a junction without `layer` agreement / shared node. |
| **BT2** | Culverts (`tunnel=culvert`) remain LINEAR_SEGMENT geometry; topology adjacency still only via **E1**. Culvert ≠ automatic navigability. |
| **BT3** | Bridge tags are too sparse (19) to drive a general “always grade-separated” rule; leave most crossings unresolved (C1). |

**Insufficient data:** no dense `layer`/`location` coverage audited here for waterways — do not invent grade-separation defaults beyond BT1–BT3.

---

## E. Locks / dams / weirs

### Measured (`routing_candidates`)

| Signal | count | osm_type mix (HIGH structures) |
|--------|------:|--------------------------------|
| lock (`waterway` lock/lock_gate or `lock=yes`) | 139 | ways + nodes + some relations |
| dam | 289 | |
| weir | 362 | |
| waterfall | 307 | (control/obstacle class from E4.1) |
| HIGH structure objects | ways 430 · nodes 311 · relations 48 | |

### Proposed rules

| Rule ID | Proposal |
|---------|----------|
| **S1** | Lock / dam / weir / waterfall objects are **topology- and navigation-relevant features** (barriers / control). |
| **S2** | They are **not** automatically passable. Future edges through them require explicit navigability policy (out of scope). |
| **S3** | Node structures near endpoint clusters (J1) should be **linked by identity/proximity audit later** — E4.5 does not snap them. |
| **S4** | Way-tagged weir/dam segments may still participate in **E1** endpoint adjacency; passability remains unresolved. |

---

## F. Relations

| Rule ID | Statement |
|---------|-----------|
| **R1** | Relation membership (`object_members`) is **provenance** only. |
| **R2** | Member **ways** are the geometry source for segments / future edges. |
| **R3** | Relation completeness ≠ continuity ≠ navigability (E3.15). |
| **R4** | Relation membership **alone** does **not** create a graph edge between members. Edges only from segment endpoint rules (E1) or later explicit policy. |
| **R5** | Cached `relation.geometry` is **not** authoritative for topology (not expanded into `routing_segments`). |

---

## G. Lakes / reservoirs / multipolygons

| Rule ID | Statement |
|---------|-----------|
| **L1** | Multipolygon **boundary/ring** ways must **not** auto-convert to a navigable centerline. |
| **L2** | Ladoga `21149039` must **not** be one artificial centerline. |
| **L3** | Lake/reservoir **open-water routing** (mask, areal graph, etc.) needs a **separate** decision — out of E4.5. |
| **L4** | Ring segments may still appear in `routing_segments` as LINESTRINGs (E4.3); future builder should filter or special-case `RELATION_MEMBER` lake rings. |

---

## H. Directionality

### Measured

| Tag | candidates with key | values |
|-----|--------------------:|--------|
| `oneway` | 12 | `yes` 9, `-1` 3 |
| `boat` | ~1687 | mostly `no` (1418), `yes` (264) |
| `boat:oneway` / `motorboat:oneway` / `canoe:oneway` | ~0–few | sparse |

### Proposal

| Rule ID | Statement |
|---------|-----------|
| **D1** | Inventory only — **do not** implement routing direction in E4.5. |
| **D2** | Future directed edges may read `oneway` / `*:oneway` / flow tags when present; default undirected until policy exists. |
| **D3** | `boat=no` is a **navigability hint**, not a topology disconnect rule by itself. |

---

## Relation PoC checks (must hold under proposed rules)

### Belomor `9909116`

- 29 member-way segments; relation not a segment.  
- Seq-chain: **28/28** links ≤10 m continuous (E4.4 / E4.5 audit).  
- **Proposed topology (E1)** preserves the chain: consecutive members share exact/near endpoints; no synthetic seam required.

### Volga–Baltic `16738852`

- 106 member-way segments.  
- Gap seq **53→54** ways `28433211` ↔ `824398188` ≈ **8.77 km**.  
- Under E1–E4: gap remains **UNRESOLVED**; **must not** become a connection.  
- PoC asserts `stitched=false` and gap ≫ 10 m.

### Ladoga `21149039`

- Multipolygon / lake; **10364** ring member segments.  
- **Not** proposed as a single centerline (L1–L2).  
- Seq-chain continuity **not** used as routing success.

---

## What remains undefined (intentionally)

- Production graph schema / node ID assignment.  
- Navigability / CEMT / draft filters.  
- Open-water lake routing model.  
- Auto-resolution of proper crossings and overlaps.  
- Snapping structure nodes to endpoint clusters.  
- Directed routing implementation.  
- Whether 1 m band may ever promote to E1-equivalent (needs precision study).

---

## Hard constraints (kept)

- No graph tables / nodes / edges  
- No changes to `water.objects`, `object_members`, conflicts, `routing_relevance`, `routing_candidates`, `routing_segments`  
- No sea-map / AquaRoute wiring  
- No new PBF  

Canonical fingerprint: objects **455001** · members **199570** · conflicts **92**
