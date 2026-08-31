# E3.6 — Multi-extract architecture for Russia water DB

Status: **architecture + local PoC only**. No new regional downloads. No graph / router / sea-map changes.

Inputs: E3.3 Belomor offline import, E3.4 Karelia coverage, E3.5 incomplete-relation QA  
(117 incompletes; mostly extract-boundary; Belomor `9909116` complete 29/29).

---

## 1. Goal

Assemble **several regional OSM PBF extracts** into one PostgreSQL/PostGIS database such that:

- the same OSM object is never duplicated;
- tags / geometry are not silently clobbered;
- relation members from different extracts **merge**;
- `seq` / `role` stay meaningful;
- each batch keeps provenance;
- cross-border relations can become **complete** after a neighbour extract arrives.

---

## 2. Strategy comparison

### A. Sequential import with UPSERT into `water.objects`

| | |
|--|--|
| **Pros** | Matches today’s importer; simple operationally; `UNIQUE (osm_type, osm_id)` already exists |
| **Cons** | Current member path is **replace-all** (`DELETE` members → `INSERT`). A second incomplete extract for relation `R` **wipes** members only present in the first extract. Geometry/tags become last-write-wins unless extra rules are bolted on. Conflict QA is awkward mid-flight |
| **Complexity** | Low code, **high risk** for multi-extract |
| **Scale** | OK for throughput, bad for correctness |
| **Provenance** | Weak (one `source_version` on the row) |
| **Conflicts** | Easy to hide |

**Verdict:** not safe as the primary Russia strategy **unless** member merge and conflict policies are rewritten first. Still useful as the final “apply canonical row” step inside a safer pipeline.

### B. Staging tables → dedup/merge → canonical `water.*`  ✅ recommended

| | |
|--|--|
| **Pros** | Clear batch boundary; can merge members; compare geometry/tags before touch canonical; keep conflict rows for QA; rematerialize without re-downloading |
| **Cons** | More tables / jobs; one extra hop |
| **Complexity** | Medium |
| **Scale** | Good — each extract is an independent stage load |
| **Provenance** | Per-batch + per-object contribution |
| **Conflicts** | Explicit, reviewable |

### C. Full source-object warehouse → materialize canonical

| | |
|--|--|
| **Pros** | Strongest audit (every extract keeps its own copy forever); easy replay |
| **Cons** | Heavier storage; more join cost; overkill before Russia-wide volume exists |
| **Complexity** | High |
| **Scale** | Excellent long-term |
| **Provenance** | Best |
| **Conflicts** | Natural |

**Verdict:** evolution of B once volume/ops justify it. E3.6 selects **B**, with C as a later hardening path (keep raw staging rows longer / never delete).

---

## 3. Chosen strategy: **B (staging → merge → canonical)**

```
PBF extract N
    → ingest to staging (batch_id)
    → merge job (identity + member union + conflict detect)
    → canonical water.objects / water.object_members
    → QA completeness (E3.5-style)
```

Canonical tables stay the ones E3.2–E3.3 already defined. Staging is additive.

---

## 4. Identity policy

**Canonical OSM identity = `(osm_type, osm_id)` only.**

Forbidden as identity (may be used only as diagnostics):

- `name`, proximity, geometry equality, `water_type`, tags hash alone.

Rationale: OSM ids are stable across regional extracts; names and geometries are not.

---

## 5. Geometry conflict policy

When the same `(osm_type, osm_id)` appears in batches A and B with **non-equivalent** geometries:

1. **Detect** — `ST_Equals` / normalized WKB hash; if equal → no conflict.
2. **Do not** silently keep “last import”.
3. **Record** a conflict row (proposed `water.object_conflicts`) with both geometries, both `batch_id`s, optional `source_version`.
4. **Canonical pick rule** (deterministic):
   1. Prefer geometry that is **valid** (`ST_IsValid`) over invalid;
   2. Else prefer **higher node/vertex count** (richer clip of the same object — typical when one extract only saw a truncated way);
   3. Else prefer batch with **newer `source_version` / OSM timestamp** if available in staging;
   4. Else prefer the geometry already canonical (stability);
   5. Always leave the conflict visible for QA until dismissed.

**Incomplete ways** (`invalid location` in an extract) never overwrite a valid canonical geometry.

### Minimal schema need (proposed, not required to apply in E3.6)

Current `water.objects` has a single `geometry` + single `source_version` — enough for one winner, **not** enough to store both sides of a conflict. Minimal add:

```text
water.object_conflicts (
  id, osm_type, osm_id, field ('geometry'|'tags'),
  batch_a, batch_b, payload_a JSONB, payload_b JSONB,
  chosen ('a'|'b'|'keep_canonical'), created_at, notes
)
```

Until that exists, merge jobs must **refuse** to overwrite differing geometry (fail the object update and log) — safer than last-write-wins.

---

## 6. Tags conflict policy

Same pattern as geometry:

1. Compare canonical tag maps (key→value).
2. Equal → no conflict.
3. Differ → conflict row; **do not** blind overwrite.
4. Canonical merge rule:
   - union keys where values agree;
   - on disagreement: prefer tags from the batch whose geometry was chosen **or** newer OSM version;
   - never drop keys silently — disputed keys listed in conflict payload;
   - `water_type` is **derived** from canonical tags after merge (not an identity, not merged independently).

---

## 7. Relation merge policy (critical)

### Problem (E3.5 → E3.6)

Karelia may store incomplete relation `R` with members `{1,2,3}`.  
Leningrad extract later brings `{3,4,5}`.  

Today’s importer **replace-all** would leave only `{3,4,5}` — **wrong**.

### Required result

Members of `R` = **ordered union** preserving OSM member list semantics:

- identity of a membership row: `(parent_osm_type, parent_osm_id, member_osm_type, member_osm_id, member_role)`  
  (role included — same way can appear with different roles rarely);
- **dedupe** identical memberships;
- **`seq`**: not “renumber by arrival order”. Use:
  1. Prefer `seq` from the batch that has the **most complete** member list for `R` as the backbone order;
  2. Insert members only present in other batches at positions consistent with relative order in their batch (order-preserving merge / patience sorting on shared subsequence);
  3. If relative order conflicts between batches → keep backbone order, append leftovers with `seq` after max, and flag `water.object_conflicts` field=`members_order`.
- After merge, re-run completeness QA (E3.5): `members_missing` vs objects present.

### Implementation sketch

```text
staging_members(batch_id, parent_*, seq, member_*, role)
→ for each parent relation:
    load all staging memberships across batches
    dedupe by (member_type, member_id, role)
    merge order (backbone = longest list)
    write canonical water.object_members
→ rebuild relation geometry from *available* member geometries
    (MultiLineString collect / area assemble — still no LineMerge seams)
```

Belomor `9909116` already complete in Karelia remains unchanged if a second extract repeats the same 29 `main_stream` ways (dedupe → same set).

---

## 8. Boundary / completeness policy

Reuse E3.5 evidence labels, normalized for ops:

| Status | Meaning | Treat as importer error? | OK for future graph/routing? |
|--------|---------|--------------------------|------------------------------|
| `complete` | all members present in canonical objects | no | candidate (still needs navigability QA later) |
| `boundary_incomplete` | missing members **absent** from contributing extracts’ PBFs | **no** | **no** until another extract/merge completes them |
| `internal_incomplete` | missing members **present** in a contributing PBF but not materialized (e.g. invalid locations, non-water nested relation) | investigate | **no** until resolved |
| `mixed` | both boundary and internal missing | investigate internals; boundary part expected | **no** |

**Rule:** `boundary_incomplete` is an expected property of regional clips (E3.5), not a failed import.

---

## 9. Provenance policy

### What exists today

- `water.data_sources` — audit rows per import run;
- `water.objects.source` / `source_version` — single values on the canonical row.

### Enough for multi-extract?

**Partially.** Enough to know “last contributing run” on the object, **not** enough to list every extract that contributed members/geometry.

### Minimal extension (proposed; defer implementation)

```text
water.import_batches (
  id, source_name, source_version, dataset_label, imported_at, notes
)

water.object_batch_links (
  osm_type, osm_id, batch_id, role ('object'|'member_contrib')
)
```

`data_sources` can map 1:1 to `import_batches` or be replaced later.  
E3.6 does **not** apply this DDL — document only unless a later stage needs it.

PoC below uses TEMP tables to prove merge without permanent schema change.

---

## 10. Overlap strategy

| Approach | Fit |
|----------|-----|
| Adjacent extracts, **no** overlap | Leaves permanent `boundary_incomplete` on shared lakes/canals (Ladoga, Onega, Volga–Baltic). Bad as sole strategy |
| **Overlap buffer** (recommended primary) | Neighbouring regions share a strip; shared ways appear in both; merge dedupes; cross-border relations complete faster |
| Parent-region (e.g. NW Federal District) | Good for huge lakes spanning many subjects; heavier download |
| Water-focused larger extract | Ideal long-term bulk; needs filter pipeline + still multi-tile merge |

**Recommend:** start Russia build with **subject-level PBFs + intentional overlap buffer**, merge via strategy B; for known mega-features (Ladoga, Onega, Volga–Baltic), prefer a **parent extract** or water-filtered wider tile when practical. Belomor sits inside Karelia and is already `complete` — overlap still helps its approaches/connections later, but the relation itself is not the border problem.

---

## 11. What E3.6 does **not** do

- No new PBF downloads / no second real region import;
- No graph, edges, seams, router, API, sea-map changes;
- No permanent staging DDL applied to production schema (proposal only);
- No automatic “fix” of incomplete relations.

---

## 12. PoC

See `ingest/poc_multi_extract_merge.py`:

- Reads **real** Belomor `9909116` members from the live DB;
- Splits them into two synthetic batches (A = first half, B = second half with overlap on the middle membership);
- Merges in TEMP tables with dedupe + order-preserving union;
- Asserts: 29 unique members, roles preserved, no duplicate identity, provenance batch links recorded.

No fabricated coordinates.
