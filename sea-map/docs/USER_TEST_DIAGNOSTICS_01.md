# USER_TEST_DIAGNOSTICS_01

Manual-test diagnostics for three AquaRoute issues found in first USER_TEST pass.

**Constraints honored:** no routing algorithm / threshold / Phase A–D / WaterGraph / fairway / hydro-gate / STEM–VETL changes. Production behavior unchanged except minimal UI request lifecycle fix for Clear/Reset.

---

## 1. RESET BUG

### Root cause

`#clear-btn` / TEST PANEL `clearRoute` cleared waypoints and status but **did not**:

1. Clear `busy` / `pendingRebuild`
2. Invalidate in-flight `computeWaterRoute` completions (token)
3. Invalidate `routeAsyncGeneration` polish

Race that leaves **«Построение маршрута»** (or blocks the next BUILD):

1. BUILD₁ sets `busy=true`, status = «Построение маршрута…»
2. User hits **Сбросить** → waypoints/status wiped, **`busy` stays true**
3. BUILD₂ hits `if (busy) { pendingRebuild=true; return }` → **never starts**, never sets a terminal status
4. BUILD₁ `finally` may leave `pendingRebuild` stuck when waypoints were emptied (`pendingRebuild` cleared only inside the rebuild `if`)
5. Late polish / stale completion can also rewrite geometry after clear

So the second request “stops moving” at **UI busy coalesce**, not inside BRouter/Overpass.

### Fix (minimal UI/state only)

- New `RouteRequestControl` with lifecycle: `RESET`, `REQUEST_START`, `REQUEST_BUSY_COLLAPSE`, `REQUEST_END`, `REQUEST_STALE_END`, `REQUEST_ERROR`
- Clear/Reset calls `reset()` + `routeAsyncGeneration.invalidate()`
- Completions apply status/geometry only when request token is still current
- DEV: `window.__aquarouteRouteLifecycle()` (no noisy `console.log`)

### Verify

- Repeated RESET → BUILD
- Preset → Clear → same preset / other preset / manual A–B

---

## 2. Беломоро-Балтийский канал

### OSM

Present. Corridor probe `(62.7–64.7N, 34.2–35.6E)`:

- ~826 waterway ways (`river` 744, `canal` 82)
- ≥30 named `Беломорканал` (`waterway=canal`)

### Overpass

Current AquaRoute queries already include `canal` — **query sees the canal**. Not a fetch-type omission.

### BRouter (`profile=river`)

| Segment | Result |
| --- | --- |
| Povenets↔Belomorsk-ish (full) | OK ~216 km (geo ~185, ratio ~1.17) |
| Mid corridor | **Bogus short** track (~7.5 km vs geo ~45, ratio ~0.17) → validator reject |

### Graph / vias / UI

- No curated Belomor vias; NW waterway box (`nearNorthwestWaterway`) caps ~**63.0°N** — northern Belomor (~64.5°N) is outside
- Выгозеро exists in lake masks; that alone does not build Belomor routing
- Not a map UI hide issue when routing fails

### Root cause

**DATA_GAP + ROUTING (BRouter quality)** — not missing OSM tags, not Overpass type filter, not UI.

Do **not** add hardcoded fairways in this task. Treat as coverage/quality gap for a later stage.

Diagnostic chain: `request → candidates → Overpass(canal present) → BRouter (full OK / mid BAD) → validator → final.rejectReason`

---

## 3. Волгоград → Астрахань

### OSM

Lower Volga corridor has river/canal waterway geometry in OSM (local Overpass samples). Not a total data absence.

### Probes (BRouter river)

| Case | Intent | Observation |
| --- | --- | --- |
| **VG-A** | ~50–100 km down from Volgograd | Endpoint-sensitive: shore/city snaps → **bogus short** or weak geometry; good river clicks improve |
| **VG-B** | Mid lower Volga | Can return **HTTP 400** (`target island detected`) on poor snaps; better river points needed |
| **VG-C** | ~50–100 km before Astrakhan | **OK** (~31 km, ratio ~1.25) |
| **VG-D** | Full Volgograd→Astrakhan | **OK** with water clicks (~456–460 km, ratio ~1.23–1.25). Geo ≫ 120 km |

### Code gate (unchanged)

When BRouter path fails and `routeSpanKm > 120`, Overpass fallback is **skipped** (`rejectReason: span_gt_120`). Observability now sets:

- `request.longSpanOverpassSkip = true`
- `phases.overpass.rejectReason = 'span_gt_120'`

**Limits were not raised.**

### Root cause

**Long-span BRouter dependency + endpoint snap sensitivity** (not missing Volga OSM, not a Volga-only geographic ban, not UI).

When manual A/B land off fairway:

1. BRouter fails / returns invalid short geometry  
2. Span > 120 → `span_gt_120`  
3. No Overpass recovery by design  

VG-D succeeding with good snaps proves data+BRouter can connect the corridor; failures are quality/snap/long-span policy, not “Volga absent”.

---

## 4. RouteTrace diagnostic completeness

**OK** (with this patch):

Chain available: `request (geoKm, longSpanOverpassSkip?) → candidates → phases A/B/C/overpass → brouterAttempts → validator → hydro → final.rejectReason` (+ E2 `knowledge` advisory).

Enough to answer “why not built?” for:

- Reset races → UI lifecycle (DEV `__aquarouteRouteLifecycle`)
- Belomor → OSM present + BRouter mid quality / coverage gap
- VG long → `span_gt_120` when BRouter fails

---

## 5. Tests / Build / Production

- Tests: **195/195** OK (`vitest run`)
- Build: **OK** (`tsc && vite build`)

**Production:** UNCHANGED routing; only Clear/Reset UI lifecycle + RouteTrace observability.

---

## 6. Stop line

Belomor / lower Volga **not** engineered further in this task. Report only; await explicit follow-up before coverage work.
