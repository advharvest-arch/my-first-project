# E3.10 — Manual conflict review + relation occurrence policy

No third-region import. No WaterGraph / sea-map / routing. No automatic canonical geometry mutation.

## Conflict workflow

```
open  →  accepted | rejected | deferred
```

Semantics (clarified in `db/init/009_conflict_review.sql`):

| Column | Meaning |
|--------|---------|
| `resolution` | **Recommendation** from merge-time policy (`keep_canonical` / `take_incoming` / `merged`). Historical audit; not rewritten by review. |
| `status` | **Human review**: `open` → `accepted` \| `rejected` \| `deferred`. |

Accepting a recommendation does **not** apply geometry. An explicit apply operation is intentionally **not** shipped in E3.10 (SAFETY > convenience).

### CLI

```bash
python3 ingest/e310_conflict_review.py list --status open
python3 ingest/e310_conflict_review.py show --id N
python3 ingest/e310_conflict_review.py accept --id N --notes '...' --i-understand-production
python3 ingest/e310_conflict_review.py reject --id N --i-understand-production
python3 ingest/e310_conflict_review.py defer  --id N --i-understand-production
python3 ingest/e310_conflict_review.py probe-demo   # safe accept/reject/defer + cleanup
```

Without `--i-understand-production`, status changes are limited to `e310-probe-*` batches.

The real 49 E3.8 geometry conflicts were left `status=open` (not bulk-reviewed).

## Relation member occurrence policy

E3.7 identity `(member_type, member_id, role)` collapses legitimate OSM duplicates
(relation `14000871` lists the same ways twice at different `seq`).

**E3.10 occurrence identity:** `(member_type, member_id, role, seq)`.

Merge rules (`merge_staging.ordered_union_members_by_occurrence`):

1. Preserve all occurrences from the backbone extract.
2. Add occurrences from the other extract only when the full occurrence key is new.
3. Do not collapse `A@30,B@31,A@32,B@33` → `A,B`.
4. If the same `(type,id,role)` has different seq sets across extracts → record `members_order` conflict; still do not silently delete occurrences.

Canonical relation `14000871` was **not** rewritten. PoC: `ingest/poc_e310_occurrence_merge.py` (TEMP only).

## Freshness (future)

Per-object OSM `version` / `timestamp` is still **not** stored.

Documented requirement for later: needed for deterministic freshness ordering between extracts. Not added in E3.10.
