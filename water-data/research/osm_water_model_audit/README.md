# OSM water model audit (research only)

Tag/role snapshot of reference OSM water objects. **Not** ingest, WRG, routing, or topology.

```bash
cd water-data/research
PYTHONPATH=. python3 -m osm_water_model_audit --out-dir ../../docs
PYTHONPATH=. python3 -m unittest tests.test_osm_water_model_audit -v
```

Does not compute distance, nearest centerline, polygon containment, or name/bbox joins.
Production code is not imported.
