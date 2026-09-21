Research-only water topology discovery. Not ingest, not WRG, not seligerDebug.

OSM water-model audit (tags/roles of reference objects, no topology):

```bash
cd water-data/research
PYTHONPATH=. python3 -m osm_water_model_audit --out-dir ../../docs
PYTHONPATH=. python3 -m unittest tests.test_osm_water_model_audit -v
```

```bash
cd water-data/research
python3 -m pip install -r requirements.txt
PYTHONPATH=. python3 -m water_topology --store tests/fixtures/seliger_store.json.gz --out-dir ../docs
PYTHONPATH=. python3 -m water_topology --store tests/fixtures/seliger_store.json.gz --validate --out-dir ../docs
PYTHONPATH=. python3 -m unittest discover -s tests -v
```

`discoverWaterGraph(seed)` expands a BFS from one OSM relation or way using shared
node ids and open waterways (`river|stream|canal`). Proximity is never a confirmed
connection. `WATERWAY_CONNECTOR` is emitted only when exactly two confirmed water
areas share nodes with that waterway (no skipping an intermediate area).
