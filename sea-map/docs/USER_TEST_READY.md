# USER_TEST_READY

Manual testing harness for AquaRoute. **No routing algorithm changes.**

## How to run

```bash
cd sea-map
npm install   # if needed
npm run dev
```

Open the local URL Vite prints (usually `http://localhost:5173/`).

The **TEST ROUTE** panel appears at the top-right **only in `npm run dev`**.
Production / `npm run build` + preview does **not** show the panel.

## How to open test mode

1. Start `npm run dev`.
2. Look for the floating **TEST ROUTE** panel (collapse with ▾).
3. Main AquaRoute panel still works as usual (click A/B on map).

## How to choose A / B

**Option 1 — coordinates**

- Enter lon/lat in A and B fields.
- Click **BUILD ROUTE**.

**Option 2 — pick on map**

- Click **Pick A**, then click the map.
- Click **Pick B**, then click the map.
- Click **BUILD ROUTE**.

(While picking, normal waypoint clicks are suppressed.)

## How to run a preset

1. Open the **Preset** dropdown (SAFE / TARGET / SAFETY / RIVERS).
2. Select e.g. `L01`, `L07`, `L2`, `N06`, `STEM`, `VETL`, `X2`.
3. Click **RUN PRESET**.
4. Read **Result** (`OK` or `ROUTE NOT FOUND`) — failures are intentional to show.

`expected:` under the preset is **tester documentation only** — not used by routing.

## How to copy RouteTrace

After a build:

- **SHOW TRACE** — expand JSON in the panel  
- **COPY TRACE** — clipboard  
- **DOWNLOAD TRACE** — `.json` file  

Send that JSON when reporting a problem.

## Where to see advisory (Open Russian Knowledge)

In **Result → Knowledge**:

- fact/advisory counts  
- type / severity / source  
- note **advisory only** (never auto-reject)

Also inside RouteTrace → `knowledge`.

## How to report a problem

Send:

1. preset id (or A/B coords)  
2. Result screenshot or text  
3. RouteTrace JSON (COPY/DOWNLOAD)  
4. Your classification guess: bug / data gap / routing weakness / safety reject / UX / knowledge-layer  

Do **not** ask the agent to auto-change thresholds until a series of manual tests is reviewed.

## Session summary

Bottom of the panel:

```
Routes tested / OK / FAIL
Methods
Knowledge matches
Hydro rejects
Validator rejects
```

**RESET SESSION** clears counters (and can clear the map route).
