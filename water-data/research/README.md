Research-only water topology discovery. Not ingest, not WRG, not seligerDebug.

```bash
cd water-data/research
python3 -m pip install -r requirements.txt
PYTHONPATH=. python3 -m water_topology --from-seliger-dumps --out-dir ../docs
PYTHONPATH=. python3 -m unittest discover -s tests -v
```

`discoverWaterGraph(seed)` / `discover_water_graph(seed, store)` expands a BFS from one OSM
relation or way using shared node ids and open waterways (`river|stream|canal`).
Proximity is never treated as a confirmed connection.
