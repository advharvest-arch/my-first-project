/**
 * Offline hydraulic barrier / navigable-lock detector (proof-of-concept).
 *
 * Pure geometry + metadata — no site names, no BRouter, no Overpass.
 * NOT wired into the production routing pipeline yet.
 */

import { haversineKm, type LngLat } from './geo';

export type HydraulicBarrier = {
  id: string;
  type: 'dam' | 'weir';
  /** Crest / barrier centerline (polyline). */
  geometry: LngLat[];
  /** Optional lock ids known to belong to this hydro site. */
  nearbyLocks?: string[];
};

export type NavigableLock = {
  id: string;
  /** Lock chamber centerline. */
  geometry: LngLat[];
  /** Approach canal / fairway feeding the chamber (optional). */
  approachGeometry?: LngLat[];
  /** Explicit navigability; default true when omitted. */
  navigable?: boolean;
  boat?: string;
  motorboat?: string;
  cemT?: string;
};

export type HydraulicCrossingClass =
  | 'legal_lock_passage'
  | 'illegal_dam_crossing'
  | 'beside_barrier'
  | 'no_barrier'
  | 'barrier_without_lock';

export type BarrierCrossingHit = {
  barrier: HydraulicBarrier;
  /** True when the path straddles the barrier crest. */
  crosses: boolean;
  /** True when the path approaches the crest without straddling. */
  beside: boolean;
  /** Min distance from any path vertex/segment to the crest (km). */
  minDistKm: number;
};

export type HydraulicPassageResult = {
  class: HydraulicCrossingClass;
  barrier: HydraulicBarrier | null;
  lock: NavigableLock | null;
  crossing: BarrierCrossingHit | null;
};

export type HydroDetectOptions = {
  /** Path must come this close to the crest while straddling (km). */
  crossBufferKm?: number;
  /**
   * Half-width of the hydraulic structure band (km). Used only when the path
   * already has opposite-side evidence — catches sparse chords that skim a
   * dam body slightly off the OSM centerline. Not a global proximity buffer.
   */
  structureBandKm?: number;
  /** "Beside" proximity without a crossing (km). */
  besideBufferKm?: number;
  /** Max distance path→lock chamber for a visit (km). */
  lockVisitKm?: number;
  /** Max distance path→approach for a visit (km). */
  approachVisitKm?: number;
  /** Candidate lock search radius from dam (km). */
  nearbyLockKm?: number;
};

const DEFAULTS: Required<HydroDetectOptions> = {
  crossBufferKm: 0.15,
  structureBandKm: 0.5,
  besideBufferKm: 0.4,
  lockVisitKm: 0.18,
  approachVisitKm: 0.4,
  nearbyLockKm: 3.5,
};

type XY = { x: number; y: number };

function localFrame(origin: LngLat) {
  const cosLat = Math.max(0.2, Math.cos((origin.lat * Math.PI) / 180));
  const toXY = (p: LngLat): XY => ({
    x: (p.lon - origin.lon) * 111.32 * cosLat,
    y: (p.lat - origin.lat) * 110.54,
  });
  return { toXY };
}

function dist2(a: XY, b: XY): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function distPointSegKm(p: XY, a: XY, b: XY): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-12) return Math.sqrt(dist2(p, a));
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  const q = { x: a.x + t * abx, y: a.y + t * aby };
  return Math.sqrt(dist2(p, q));
}

function minDistPointPolylineKm(p: LngLat, line: LngLat[]): number {
  if (!line.length) return Infinity;
  if (line.length === 1) return haversineKm(p, line[0]!);
  const { toXY } = localFrame(line[0]!);
  const xy = toXY(p);
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    best = Math.min(best, distPointSegKm(xy, toXY(line[i - 1]!), toXY(line[i]!)));
  }
  return best;
}

function minDistPathToPolylineKm(path: LngLat[], line: LngLat[]): number {
  let best = Infinity;
  for (const p of path) best = Math.min(best, minDistPointPolylineKm(p, line));
  // Also sample segment midpoints (sparse BRouter vertices).
  for (let i = 1; i < path.length; i++) {
    const mid = {
      lon: (path[i - 1]!.lon + path[i]!.lon) / 2,
      lat: (path[i - 1]!.lat + path[i]!.lat) / 2,
    };
    best = Math.min(best, minDistPointPolylineKm(mid, line));
  }
  return best;
}

/** Signed side of point relative to directed segment a→b (−1 / 0 / +1). */
function sideOfSeg(p: XY, a: XY, b: XY): number {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  if (Math.abs(cross) < 1e-9) return 0;
  return cross > 0 ? 1 : -1;
}

/**
 * Dominant dam axis: longest crest segment (local meters).
 * Used to classify "sides" of the barrier for sparse paths.
 */
function damAxis(barrier: HydraulicBarrier): { origin: LngLat; a: XY; b: XY } | null {
  const g = barrier.geometry;
  if (g.length < 2) return null;
  const origin = g[0]!;
  const { toXY } = localFrame(origin);
  let bestI = 0;
  let bestLen = -1;
  for (let i = 1; i < g.length; i++) {
    const len = Math.sqrt(dist2(toXY(g[i - 1]!), toXY(g[i]!)));
    if (len > bestLen) {
      bestLen = len;
      bestI = i;
    }
  }
  return { origin, a: toXY(g[bestI - 1]!), b: toXY(g[bestI]!) };
}

/** Sample points along segment a→b (endpoints + interior). Denser for long chords. */
function sampleSegPoints(a: LngLat, b: LngLat): LngLat[] {
  const lenKm = haversineKm(a, b);
  // ~200 m steps on long BRouter chords; always include quarters + midpoint.
  const steps = Math.max(4, Math.min(24, Math.ceil(lenKm / 0.2)));
  const out: LngLat[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push({ lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t });
  }
  return out;
}

/** Min distance from segment a→b to a polyline (km). */
function minDistSegToPolylineKm(a: LngLat, b: LngLat, line: LngLat[]): number {
  let best = Infinity;
  for (const p of sampleSegPoints(a, b)) {
    best = Math.min(best, minDistPointPolylineKm(p, line));
  }
  return best;
}

function pathSidesOfDam(
  path: LngLat[],
  barrier: HydraulicBarrier,
  nearKm: number,
): { neg: boolean; pos: boolean; near: boolean; minDistKm: number } {
  const axis = damAxis(barrier);
  let neg = false;
  let pos = false;
  let near = false;
  let minDistKm = Infinity;
  if (!axis) {
    minDistKm = minDistPathToPolylineKm(path, barrier.geometry);
    return { neg: false, pos: false, near: minDistKm <= nearKm, minDistKm };
  }
  const { toXY } = localFrame(axis.origin);

  const mark = (p: LngLat, forceSide: boolean) => {
    const d = minDistPointPolylineKm(p, barrier.geometry);
    minDistKm = Math.min(minDistKm, d);
    if (d <= nearKm) near = true;
    if (!forceSide && d > nearKm * 4) return;
    const s = sideOfSeg(toXY(p), axis.a, axis.b);
    if (s < 0) neg = true;
    if (s > 0) pos = true;
  };

  for (const p of path) mark(p, false);

  // Sparse long chords: if a segment approaches the crest, classify BOTH
  // endpoints' sides even when they are far from the dam.
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const segDist = minDistSegToPolylineKm(a, b, barrier.geometry);
    minDistKm = Math.min(minDistKm, segDist);
    if (segDist <= nearKm) {
      near = true;
      mark(a, true);
      mark(b, true);
      mark({ lon: (a.lon + b.lon) / 2, lat: (a.lat + b.lat) / 2 }, true);
    }
  }
  return { neg, pos, near, minDistKm };
}

/**
 * True when the path straddles the crest.
 * Close skim uses `crossBufferKm`; confirmed opposite-side crossings may use
 * the wider structure band (dam body half-width) for sparse OSM crests.
 */
export function pathCrossesBarrier(
  path: LngLat[],
  barrier: HydraulicBarrier,
  crossBufferKm = DEFAULTS.crossBufferKm,
  structureBandKm = DEFAULTS.structureBandKm,
): boolean {
  if (path.length < 2 || barrier.geometry.length < 2) return false;
  const axis = damAxis(barrier);
  if (!axis) return false;
  const { toXY } = localFrame(axis.origin);

  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const samples = sampleSegPoints(a, b);
    const segDist = minDistSegToPolylineKm(a, b, barrier.geometry);

    // Side transitions along a long chord (not only endpoints).
    let sawNeg = false;
    let sawPos = false;
    for (const s of samples) {
      const side = sideOfSeg(toXY(s), axis.a, axis.b);
      if (side < 0) sawNeg = true;
      if (side > 0) sawPos = true;
    }
    if (sawNeg && sawPos && segDist <= structureBandKm) return true;

    if (segDist > crossBufferKm) continue;
    const sa = sideOfSeg(toXY(a), axis.a, axis.b);
    const sb = sideOfSeg(toXY(b), axis.a, axis.b);
    // Opposite sides, or either endpoint on the crest line with the other off it.
    if (sa !== 0 && sb !== 0 && sa !== sb) return true;
    if (sa === 0 && sb !== 0) return true;
    if (sb === 0 && sa !== 0) return true;
    if (sa === 0 && sb === 0 && segDist <= crossBufferKm) return true;
  }
  // Fallback: accumulated opposite sides + structure-band proximity.
  const sides = pathSidesOfDam(path, barrier, Math.max(structureBandKm, 0.8));
  return sides.neg && sides.pos && sides.minDistKm <= structureBandKm;
}

export function pathBesideBarrier(
  path: LngLat[],
  barrier: HydraulicBarrier,
  besideBufferKm = DEFAULTS.besideBufferKm,
  crossBufferKm = DEFAULTS.crossBufferKm,
  structureBandKm = DEFAULTS.structureBandKm,
): boolean {
  if (pathCrossesBarrier(path, barrier, crossBufferKm, structureBandKm)) return false;
  const sides = pathSidesOfDam(path, barrier, besideBufferKm);
  return sides.near && sides.minDistKm <= besideBufferKm;
}

function isLockNavigable(lock: NavigableLock): boolean {
  if (lock.navigable === false) return false;
  if (lock.boat === 'no' || lock.motorboat === 'no') return false;
  if (lock.navigable === true) return true;
  if (lock.boat === 'yes' || lock.motorboat === 'yes' || lock.cemT) return true;
  // Chamber geometry present → treat as navigable unless explicitly denied.
  return lock.geometry.length >= 1;
}

function pathVisitsPolyline(path: LngLat[], line: LngLat[] | undefined, tolKm: number): boolean {
  if (!line?.length) return false;
  return minDistPathToPolylineKm(path, line) <= tolKm;
}

/**
 * Lock forms a hydraulic passage across the barrier when its chamber / approach
 * endpoints sit on opposite sides of the dam axis (not merely nearby).
 */
export function lockConnectsBarrierSides(
  barrier: HydraulicBarrier,
  lock: NavigableLock,
): boolean {
  const axis = damAxis(barrier);
  if (!axis) return false;
  const { toXY } = localFrame(axis.origin);

  const samples: LngLat[] = [...lock.geometry];
  if (lock.approachGeometry?.length) {
    samples.push(lock.approachGeometry[0]!, lock.approachGeometry[lock.approachGeometry.length - 1]!);
  }
  if (samples.length < 2) return false;

  let neg = false;
  let pos = false;
  for (const p of samples) {
    const s = sideOfSeg(toXY(p), axis.a, axis.b);
    if (s < 0) neg = true;
    if (s > 0) pos = true;
  }
  // Chamber sitting in a notch: also accept if lock is very close to crest
  // AND approach samples reach both sides.
  if (neg && pos) return true;

  if (!lock.approachGeometry?.length) return false;
  let aNeg = false;
  let aPos = false;
  for (const p of lock.approachGeometry) {
    const s = sideOfSeg(toXY(p), axis.a, axis.b);
    if (s < 0) aNeg = true;
    if (s > 0) aPos = true;
  }
  return aNeg && aPos;
}

/** Path uses this lock as a water passage (visit + connecting lock + A→B). */
export function pathUsesLockPassage(
  path: LngLat[],
  barrier: HydraulicBarrier,
  lock: NavigableLock,
  opts: HydroDetectOptions = {},
): boolean {
  if (!isLockNavigable(lock)) return false;
  if (!lockConnectsBarrierSides(barrier, lock)) return false;
  const lockVisit = opts.lockVisitKm ?? DEFAULTS.lockVisitKm;
  const approachVisit = opts.approachVisitKm ?? DEFAULTS.approachVisitKm;

  // Must visit the lock chamber — approach proximity alone is not enough
  // (dam chords can skim near an approach canal without using the lock).
  const visitsChamber = pathVisitsPolyline(path, lock.geometry, lockVisit);
  if (!visitsChamber) return false;

  if (lock.approachGeometry?.length) {
    const visitsApproach = pathVisitsPolyline(path, lock.approachGeometry, approachVisit);
    if (!visitsApproach) {
      // Chamber alone only if it already straddles the dam axis.
      const axis = damAxis(barrier);
      if (!axis) return false;
      const { toXY } = localFrame(axis.origin);
      let neg = false;
      let pos = false;
      for (const p of lock.geometry) {
        const s = sideOfSeg(toXY(p), axis.a, axis.b);
        if (s < 0) neg = true;
        if (s > 0) pos = true;
      }
      if (!(neg && pos)) return false;
    }
  }

  // A→B must happen through the lock corridor (not a global skim of a distant crest).
  if (!pathCrossesBarrierViaLock(path, barrier, lock)) return false;

  // Reject damCrest chord outside the lock notch (crest hug far from chamber).
  const crestAwayKm = damCrestAwayFromLockKm(path, barrier, lock);
  if (crestAwayKm > 0.25) return false;
  return true;
}

/**
 * Path transitions barrier sides while traveling the lock chamber / approach
 * (hydraulic A→B through the notch — not mere proximity).
 */
function pathCrossesBarrierViaLock(
  path: LngLat[],
  barrier: HydraulicBarrier,
  lock: NavigableLock,
): boolean {
  const axis = damAxis(barrier);
  if (!axis) return false;
  const { toXY } = localFrame(axis.origin);
  const corridor = [...lock.geometry, ...(lock.approachGeometry ?? [])];
  if (corridor.length < 1) return false;

  let neg = false;
  let pos = false;
  const mark = (pt: LngLat) => {
    if (minDistPointPolylineKm(pt, corridor) > 1.0) return;
    const s = sideOfSeg(toXY(pt), axis.a, axis.b);
    if (s < 0) neg = true;
    if (s > 0) pos = true;
  };

  for (const pt of path) mark(pt);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    if (minDistSegToPolylineKm(a, b, corridor) > 1.0) continue;
    for (const pt of sampleSegPoints(a, b)) mark(pt);
  }
  if (neg && pos) return true;

  // Straddling chamber: require the path to visit BOTH chamber ends (A and B),
  // not merely skim one head from the same pool.
  if (lock.geometry.length >= 2) {
    const head = lock.geometry[0]!;
    const tail = lock.geometry[lock.geometry.length - 1]!;
    const nearHead = pathVisitsPolyline(path, [head], DEFAULTS.lockVisitKm);
    const nearTail = pathVisitsPolyline(path, [tail], DEFAULTS.lockVisitKm);
    if (!(nearHead && nearTail)) return false;
    let cNeg = false;
    let cPos = false;
    for (const p of lock.geometry) {
      const s = sideOfSeg(toXY(p), axis.a, axis.b);
      if (s < 0) cNeg = true;
      if (s > 0) cPos = true;
    }
    return cNeg && cPos;
  }
  return false;
}

/** True when the path hugs any crest polyline far from the lock chamber. */
function pathRidesCrestAwayFromLock(
  path: LngLat[],
  barriers: HydraulicBarrier[],
  lock: NavigableLock,
): boolean {
  for (const barrier of barriers) {
    if (damCrestAwayFromLockKm(path, barrier, lock) > 0.25) return true;
  }
  return false;
}

/** Length of path edges that hug the crest more than `sepKm` from the lock. */
function damCrestAwayFromLockKm(
  path: LngLat[],
  barrier: HydraulicBarrier,
  lock: NavigableLock,
  hugKm = 0.35,
  sepKm = 0.45,
): number {
  let km = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    for (const mid of sampleSegPoints(a, b)) {
      const dCrest = minDistPointPolylineKm(mid, barrier.geometry);
      if (dCrest > hugKm) continue;
      const dLock = minDistPointPolylineKm(mid, lock.geometry);
      if (dLock <= sepKm) continue;
      km += haversineKm(a, b) / Math.max(1, sampleSegPoints(a, b).length - 1);
      break;
    }
  }
  return km;
}

export function detectHydraulicBarrierCrossings(
  path: LngLat[],
  barriers: HydraulicBarrier[],
  opts: HydroDetectOptions = {},
): BarrierCrossingHit[] {
  const crossBufferKm = opts.crossBufferKm ?? DEFAULTS.crossBufferKm;
  const structureBandKm = opts.structureBandKm ?? DEFAULTS.structureBandKm;
  const besideBufferKm = opts.besideBufferKm ?? DEFAULTS.besideBufferKm;
  const out: BarrierCrossingHit[] = [];
  for (const barrier of barriers) {
    const crosses = pathCrossesBarrier(path, barrier, crossBufferKm, structureBandKm);
    const beside =
      !crosses &&
      pathBesideBarrier(path, barrier, besideBufferKm, crossBufferKm, structureBandKm);
    const minDistKm = minDistPathToPolylineKm(path, barrier.geometry);
    if (crosses || beside || minDistKm <= besideBufferKm * 2) {
      out.push({ barrier, crosses, beside, minDistKm });
    }
  }
  return out;
}

export function findNearbyNavigableLocks(
  barrier: HydraulicBarrier,
  locks: NavigableLock[],
  opts: HydroDetectOptions = {},
): NavigableLock[] {
  const nearbyKm = opts.nearbyLockKm ?? DEFAULTS.nearbyLockKm;
  const hinted = new Set(barrier.nearbyLocks ?? []);
  const out: NavigableLock[] = [];
  for (const lock of locks) {
    if (!isLockNavigable(lock)) continue;
    if (hinted.has(lock.id)) {
      out.push(lock);
      continue;
    }
    const d = minDistPathToPolylineKm(lock.geometry, barrier.geometry);
    if (d <= nearbyKm) out.push(lock);
  }
  return out;
}

export function validateHydraulicPassage(
  path: LngLat[],
  barrier: HydraulicBarrier,
  locks: NavigableLock[],
  opts: HydroDetectOptions = {},
): HydraulicPassageResult {
  return classifyHydraulicCrossing(path, [barrier], locks, opts);
}

/**
 * Classify the path against a set of barriers + locks.
 *
 * Lock corridors often pass through a notch without intersecting the dam
 * centerline — legal passage is checked before returning beside/no-cross.
 */
export function classifyHydraulicCrossing(
  path: LngLat[],
  barriers: HydraulicBarrier[],
  locks: NavigableLock[],
  opts: HydroDetectOptions = {},
): HydraulicPassageResult {
  if (path.length < 2 || !barriers.length) {
    return { class: 'no_barrier', barrier: null, lock: null, crossing: null };
  }

  const hits = detectHydraulicBarrierCrossings(path, barriers, opts);

  // 1) Legal lock passage through a connecting chamber/approach (A→B), even
  // when the path never skims the crest polyline (lockCut / notch).
  // Consider every navigable lock — not only those within nearbyLockKm of a
  // crest fragment (multi-piece sites can separate crest and lock by several km).
  for (const barrier of barriers) {
    for (const lock of locks) {
      if (!isLockNavigable(lock)) continue;
      if (!pathUsesLockPassage(path, barrier, lock, opts)) continue;
      if (pathRidesCrestAwayFromLock(path, barriers, lock)) continue;
      const crossing =
        hits.find((h) => h.barrier.id === barrier.id) ??
        ({
          barrier,
          crosses: true,
          beside: false,
          minDistKm: minDistPathToPolylineKm(path, barrier.geometry),
        } satisfies BarrierCrossingHit);
      return {
        class: 'legal_lock_passage',
        barrier,
        lock,
        crossing,
      };
    }
  }

  if (!hits.length) {
    return { class: 'no_barrier', barrier: null, lock: null, crossing: null };
  }

  // 2) Prefer an actual crest crossing over a mere beside hit.
  const crossingHit = hits.find((h) => h.crosses) ?? null;
  if (!crossingHit) {
    const beside = hits.find((h) => h.beside) ?? hits[0]!;
    return {
      class: 'beside_barrier',
      barrier: beside.barrier,
      lock: null,
      crossing: beside,
    };
  }

  const barrier = crossingHit.barrier;
  const candidates = findNearbyNavigableLocks(barrier, locks, opts);

  if (!candidates.length) {
    return {
      class: 'barrier_without_lock',
      barrier,
      lock: null,
      crossing: crossingHit,
    };
  }

  // Locks exist nearby but none form a valid connecting passage for this path.
  return {
    class: 'illegal_dam_crossing',
    barrier,
    lock: candidates[0] ?? null,
    crossing: crossingHit,
  };
}
