# E3.12 — Volga–Baltic coverage experiment (relation 16738852)

Read-only forensics. **No** new PBF download. **No** canonical mutations. **No** WaterGraph.

## A. Current state

| Field | Value |
|-------|-------|
| name | Волго-Балтийский канал |
| type / waterway | waterway / canal |
| members total | **106** (all `way`, empty role) |
| present in `water.objects` | **54** |
| missing | **52** |
| relation geometry | MULTILINESTRING, 902 pts, ~456.6 km (from present members only) |
| relation bbox (assembled) | 30.36–35.84E, 59.77–61.27N |

Present member provenance: **53** Leningrad-only, **1** Karelia+Leningrad overlap.

Both Karelia and Leningrad PBFs contain the **relation object** with all **106** member references (OSM version 5), but most member **ways** are clipped out of the extracts.

## B. Missing members (52)

| Class | Count | Meaning |
|-------|------:|---------|
| `absent_from_both_extract_pbfs` | **51** | Member way id not in Karelia PBF and not in Leningrad PBF → outside both extracts. **coords = unknown** from available data. |
| `in_karelia_pbf_only_not_imported_as_water` | **1** | way `824398188` @ seq 54 is inside Karelia PBF / overlaps Karelia-only bbox (~36.06E, 61.19N) but was **not** loaded into `water.objects` (importer water-tag filter — not a bbox miss). |

No missing member is “inside Leningrad extract but absent from DB” except the filter case above for Karelia.

## C. Gaps

**One contiguous gap:** seq **54–105** (52 ways).  
Seq 0–53 present; nothing present after the gap (gap reaches end of relation).

## D. Geographic coverage

| Layer | Bbox / note |
|-------|-------------|
| Extract Karelia-only objects | ~29.30–37.97E, 60.73–66.75N |
| Extract Leningrad-only objects | ~26.98–35.96E, 58.39–61.34N |
| Present Volga–Baltic members | 30.36–35.84E, 59.77–61.27N |
| Last present member (seq 53, way 28433211) | centroid ~35.70E, 61.08N (context only) |
| Missing seq 55–105 | **coords unknown** (not in either local PBF) |
| Missing seq 54 (way 824398188) | known from Karelia PBF: ~36.06E, 61.19N |

Present corridor runs roughly St. Petersburg → east toward Onega/Vytegra. The missing tail continues beyond the eastern Leningrad / southern Karelia coverage.

## E. Why incomplete

1. **Extract coverage:** Volga–Baltic is a long inter-regional waterway. Karelia + Leningrad include the western ~half of members; the eastern continuation’s ways are not packaged in those PBFs (even though the relation skeleton lists them).  
2. **Importer filter:** 1 member way exists in Karelia PBF but lacks water tags → not in `water.objects`.  
3. **Not a merge bug:** membership list is 106; completeness correctly requires objects to exist.

## F. Completeness policy (confirmed)

```
complete ⇔ ∀ members ∃ row in water.objects
```

Assembled MULTILINESTRING does **not** make the relation complete. No placeholders.

## G. Coverage strategy (no download performed)

| Option | Verdict |
|--------|---------|
| A. One more regional PBF | **Best next experiment:** `vologda_oblast-latest.osm.pbf` (~52 MB HEAD on openstreetmap.fr) — canal corridor continues into Vologda (Vytegra…). |
| B. Overlap / buffer | Still needed at borders; use existing staging→merge. |
| C. NW federal district (~710 MB) | Geographically broad; oversized for this single-relation test. |
| D. Planet / all-Russia | **Not** required. |
| E. Without mass Russia | **Yes:** targeted Vologda (+ maybe Yaroslavl later) **or** OSM API `relation/16738852/full` (Belomor-style) without Russia-wide import. |

**Recommended next source (not downloaded in E3.12):**  
`https://download.openstreetmap.fr/extracts/russia/northwestern_federal_district/vologda_oblast-latest.osm.pbf`

## H. Belomor / Ladoga comparison

| Relation | Present/listed | Why |
|----------|----------------|-----|
| Belomor 9909116 | **29/29** | Entire relation + members sit inside Karelia water import. |
| Ladoga 21149039 | **10364/10364** | Members completed by Karelia+Leningrad overlap merge. |
| Volga–Baltic 16738852 | **54/106** | Corridor leaves both extracts; 51 member ways absent from both PBFs. |

## I–J. Safety / audits

Fingerprint unchanged: objects **422327**, members **186823**.  
Belomor 29/29, Ladoga 10364/10364, Volga–Baltic 54/106.  
identity dups 0, orphan parents 0, invalid geom 0.

## Suggested E3.13

Staging import of **Vologda oblast** (or OSM API full relation as minimal alternative) → E3.7 merge → re-measure 16738852 completeness — still no WaterGraph.
