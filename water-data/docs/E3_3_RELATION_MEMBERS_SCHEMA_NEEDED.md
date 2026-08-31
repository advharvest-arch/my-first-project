# E3.3: relation members schema — resolved

Approved: use normalized table **`water.object_members`** (not `members JSONB`).

Implemented in `db/init/004_object_members.sql`.  
Importer: `ingest/import_osm.py` (pyosmium).  
Download: `ingest/download_belomor.sh` (OSM API `relation/9909116/full`).

Historical analysis that led to the stop/approve cycle is kept for provenance of the decision; see git history on this file's first revision if needed.
