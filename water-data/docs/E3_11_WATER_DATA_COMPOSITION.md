# E3.11 — Water-data composition for a future Russia-wide DB

**Analysis only.** No new PBF, no third region, no canonical mutations, no WaterGraph.

Question answered here:

> What must the local water DB contain so a later stage can build WaterGraph from it?

---

## A. Inventory (post–E3.10 fingerprint)

| Metric | Value |
|--------|------:|
| objects | **422327** |
| members | **186823** |

### By `osm_type`

| osm_type | count |
|----------|------:|
| way | 403903 |
| relation | 17581 |
| node | 843 |

### By normalized `water_type`

| water_type | count | notes |
|------------|------:|-------|
| (null) | 233126 | mostly ditch/drain + untyped natural=water + import noise |
| other | 114145 | largely ditch/drain mapped to other |
| stream | 31778 | |
| lake | 23845 | |
| river | 14527 | |
| river_area | 3526 | `water=river` areas |
| canal | 733 | |
| reservoir | 647 | |

### By geometry type

| gtype | count |
|-------|------:|
| LINESTRING | 334620 |
| MULTIPOLYGON | 86397 |
| POINT | 843 |
| MULTILINESTRING | 416 |
| POLYGON | 51 |

### `waterway=*` (raw OSM)

| value | count | rough role |
|-------|------:|------------|
| ditch | 86920 | LOW |
| stream | 31778 | MEDIUM |
| drain | 27175 | LOW |
| river | 14527 | HIGH |
| canal | 733 | HIGH |
| weir / waterfall / dam / lock_gate | ~962 | HIGH (obstacles/control) |
| fairway / link | 78 | HIGH |
| (none) | 259452 | polygons / non-waterway |

### `natural=water` / `water=*`

| water | count |
|-------|------:|
| (none) subtype | ~54k |
| lake | ~23850 |
| river (area) | 3526 |
| pond | 3325 |
| reservoir | ~470 (+ landuse=reservoir 390) |
| oxbow / wastewater / basin / … | smaller |

### Relations

| type | count | complete | incomplete |
|------|------:|---------:|-----------:|
| multipolygon | 17281 | 17170 | 111 |
| waterway | 292 | 246 | 46 |
| route | 7 | 2 | 5 |
| boundary | 1 | 0 | 1 |
| **total** | **17581** | **17418** | **163** |

---

## B. Routing relevance (classification only — nothing deleted)

| Category | Relevance | Rationale |
|----------|-----------|-----------|
| river / canal centerlines + waterway relations | **HIGH** | Core navigable network candidates |
| lake / reservoir polygons + MP water relations | **HIGH** | Open-water masks / lake routing context |
| lock / dam / weir / waterfall | **HIGH** | Barriers / control structures |
| fairway / link | **HIGH** | Explicit navigation channels |
| stream | **MEDIUM** | Topology / small-craft / connectivity |
| river_area / riverbank polygons | **MEDIUM** | Validation, width context, snap |
| nodes (fuel, access, lock_gate) | **MEDIUM** | Snap / amenities |
| drain / ditch | **LOW** | Rarely routing; noise at Russia scale |
| pond / oxbow | **LOW** | Local reference |
| wood / wetland / bare_rock collateral | **IGNORE** | Import noise; not needed for routing extract |
| source:/mml:/fixme audit tags | **IGNORE** for router; keep for audit |

---

## C. Geometry roles

| Geometry | Used for |
|----------|----------|
| **LINESTRING** | River/stream/canal/fairway **centerlines** — primary WaterGraph edge raw material |
| **MULTILINESTRING** | Assembled **waterway relations** (Belomor, Volga–Baltic); also incomplete multipolygon shells (Ladoga/Onega currently) |
| **MULTIPOLYGON** | Lake / reservoir / river_area **polygons** — mask, open-water, validation |
| **POLYGON** | Rare closed ways |
| **POINT** | Lock gates, fuel, access points — snap / POI, not edges |

Special cases from this DB:

- **Belomor `9909116`**: MULTILINESTRING centerline from relation members — ideal waterway-relation pattern.
- **Ladoga `21149039` / Onega `1308279`**: still MULTILINESTRING shells in `objects.geometry` while members are complete — polygon materialization gap for some large MPs (known from E3.9), not a missing-member problem.

---

## D. Tags — tiers (keep all; classify for future router)

**Essential** (router / graph build inputs):  
`waterway`, `natural`, `water`, `landuse` (reservoir), `name`, `type`, `boat`, `lock`, `tunnel`, `intermittent`

**Useful**:  
`name:ru`, `name:en`, `width`, `CEMT`/`cemt`, `canoe`, `motorboat`, draft/width/height limits, `layer`, `bridge`, `rapids`, `seasonal`, `gvr:code`, `wikidata`

**Audit-only**:  
`source*`, `mml:class`, `fixme`, `note`, `wikipedia`, importer ids, landcover keys (`leaf_type`, …)

Do **not** strip tags from `water.objects` — JSONB is the provenance store.

---

## E. Relation inventory (examples)

| relation | name | type | members present/listed | role for future graph |
|----------|------|------|-------------------------|------------------------|
| 9909116 | Беломорканал | waterway/canal | **29/29** | HIGH centerline relation |
| 21149039 | Ладожское озеро | multipolygon | **10364/10364** | HIGH lake; geometry column still lineshell |
| 16738852 | Волго-Балтийский канал | waterway/canal | **54/106** | HIGH but incomplete across extracts |

Waterway relations: **292** (84% complete in current coverage).  
Incomplete overall: **163** relations / **5613** missing member refs — mostly extract-boundary.

---

## F. Coverage — what this DB can already feed

| Future building block | Status from current data |
|-----------------------|--------------------------|
| 1. Water object catalog | **Yes** — identity, tags, geometry, provenance |
| 2. Centerline dataset | **Partial** — river/canal/stream present; volume dominated by ditch/drain |
| 3. Lake/reservoir polygons | **Yes** (mostly MULTIPOLYGON); large lakes may need MP rebuild |
| 4. Relation dataset | **Yes** — members + occurrence policy (E3.10) + completeness |
| 5. Endpoint / snap dataset | **Partial** — few nodes; line endpoints not precomputed |
| WaterGraph edges | **No** — out of scope |

---

## G. Russia-scale estimate (rough — no downloads)

Basis: **422327** unique objects from Karelia + Leningrad (~293 MB PBF, with overlap).  
Prior note: Northwestern FD extract ~620 MB class.

| Scope | Order-of-magnitude objects |
|-------|----------------------------|
| Northwestern FD | ~0.7e6 – 1.5e6 |
| European Russia | ~3e6 – 10e6 |
| All Russia (incl. ditch/drain) | ~10e6 – 40e6+ |
| All Russia **HIGH-only** (excl. ditch/drain noise) | ~1e6 – 5e6 |

Caveats: water density varies; importer retains collateral non-water; MB≠unique objects. **Not** for hard capacity planning without a measured pilot.

---

## H. Proposed canonical model

### Keep (already sufficient as core store)

- `water.objects`
- `water.object_members`
- `water.import_batches` / `object_batch_links` / `object_conflicts` / `data_sources`

### Gaps for “DB → WaterGraph” (propose only — **not created in E3.11**)

1. **`osm_version` + `osm_timestamp`** on objects/staging — freshness across extracts.  
2. **Routing relevance classification** — VIEW or generated column (`HIGH|MEDIUM|LOW|IGNORE`); do not delete rows.  
3. **Endpoints** — optional table **or** compute at graph-build time (prefer defer).  
4. Navigability — **no new table required**; essential tags already on objects.

### Explicitly not now

- Graph edge tables, synthetic geometry, AquaRoute/sea-map wiring.

---

## I. Already enough

- Stable OSM identity + geometry + full tags  
- Relation membership with occurrence identity  
- Multi-extract provenance + conflict review workflow  
- Enough HIGH centerlines + lake polygons in NW pilot to prototype a **later** WaterGraph builder offline

## J. Still missing

- Per-object OSM freshness fields  
- Explicit relevance filter (view)  
- Broader geographic coverage (more extracts — future stage)  
- Consistent large-lake MULTIPOLYGON materialization  
- Precomputed endpoints (optional)  
- Richer navigability tagging in OSM itself (data limitation)

---

## K. Validation (unchanged)

- objects **422327**, members **186823**  
- Belomor **29/29**, Ladoga **10364/10364**  
- identity dups **0**, orphan parents **0**, invalid geom **0**

## Timestamp note (from E3.9/E3.10)

Still required later for deterministic freshness; **not** added in E3.11.

## Suggested E3.12

Read-only **routing-relevance VIEW** (+ optional inventory of HIGH subset counts by bbox) **or** measured single additional overlapping extract for Volga–Baltic completeness — still **no** WaterGraph.
