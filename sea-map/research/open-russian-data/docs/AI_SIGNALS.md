# AI preparation (no ML)

AI must not invent fairways. Future features:

| Signal | Source today |
| --- | --- |
| route rejected / accepted | RouteTrace (E0) |
| user correction | RouteTrace schema-only |
| deviation from known fairway | OSM fairway pins + future open km-segments |
| navigation restriction | NavigationEvent from bulletins |
| lock / barrier | Kim/Volgo-Balt lock mentions; hydro-gate already separate |
| seasonal restriction | AT-442 open/close dates (when table-extracted) |
| OSM/BRouter disagreement | compare lengths/paths vs facts |
| official/open-data disagreement | WaterFact vs OSM tags |
| coverage gap | missing segment inventory |
| source confidence | `sourceQuality` (not routing cost) |

Chain:

```
facts → routes → errors → user corrections → learning signal
```
