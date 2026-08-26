import { describe, expect, it } from 'vitest';
import type { LngLat } from '../geo';
import {
  classifyHydraulicCrossing,
  detectHydraulicBarrierCrossings,
  findNearbyNavigableLocks,
  lockConnectsBarrierSides,
  pathBesideBarrier,
  pathCrossesBarrier,
  pathUsesLockPassage,
  type HydraulicBarrier,
  type NavigableLock,
} from '../hydro-barriers';

const p = (lon: number, lat: number): LngLat => ({ lon, lat });

/** E–W dam crest; south = lower pool, north = upper pool. */
function syntheticSite(id: string, lon0: number, latCrest: number) {
  const barrier: HydraulicBarrier = {
    id: `${id}-dam`,
    type: 'dam',
    geometry: [p(lon0 - 0.04, latCrest), p(lon0, latCrest), p(lon0 + 0.04, latCrest)],
  };
  const lock: NavigableLock = {
    id: `${id}-lock`,
    boat: 'yes',
    // Chamber spans crest (connects sides).
    geometry: [p(lon0 - 0.002, latCrest - 0.004), p(lon0 - 0.002, latCrest + 0.004)],
    approachGeometry: [
      p(lon0 - 0.002, latCrest - 0.012),
      p(lon0 - 0.002, latCrest - 0.004),
      p(lon0 - 0.002, latCrest + 0.004),
      p(lon0 - 0.002, latCrest + 0.012),
    ],
  };
  /** Lock entirely south of crest — does not connect pools. */
  const danglingLock: NavigableLock = {
    id: `${id}-dangling`,
    boat: 'yes',
    geometry: [p(lon0 + 0.02, latCrest - 0.01), p(lon0 + 0.025, latCrest - 0.008)],
    approachGeometry: [p(lon0 + 0.02, latCrest - 0.02), p(lon0 + 0.02, latCrest - 0.01)],
  };
  return { barrier, lock, danglingLock, lon0, latCrest };
}

describe('hydro-barriers (offline detector)', () => {
  const site = syntheticSite('alpha', 40.0, 50.0);

  it('A: dam crossing + valid lock → legal_lock_passage', () => {
    const path = [
      p(40.0, 49.97),
      p(39.998, 49.988),
      p(39.998, 50.0), // through chamber
      p(39.998, 50.012),
      p(40.0, 50.03),
    ];
    const result = classifyHydraulicCrossing(path, [site.barrier], [site.lock]);
    expect(result.class).toBe('legal_lock_passage');
    expect(result.lock?.id).toBe('alpha-lock');
    expect(pathUsesLockPassage(path, site.barrier, site.lock)).toBe(true);
  });

  it('B: dam crossing without lock → barrier_without_lock', () => {
    // Sparse chord across crest (BRouter-like).
    const path = [p(40.02, 49.97), p(40.02, 50.03)];
    expect(pathCrossesBarrier(path, site.barrier)).toBe(true);
    const result = classifyHydraulicCrossing(path, [site.barrier], []);
    expect(result.class).toBe('barrier_without_lock');
  });

  it('C: route beside dam → beside_barrier', () => {
    // Stays south of crest, approaches within beside buffer (~0.25 km).
    const path = [p(39.9, 49.97), p(40.0, 49.9977), p(40.1, 49.97)];
    expect(pathCrossesBarrier(path, site.barrier)).toBe(false);
    expect(pathBesideBarrier(path, site.barrier)).toBe(true);
    const result = classifyHydraulicCrossing(path, [site.barrier], [site.lock]);
    expect(result.class).toBe('beside_barrier');
  });

  it('D: route through lock corridor → legal_lock_passage', () => {
    const path = [
      p(39.998, 49.985),
      ...site.lock.approachGeometry!,
      p(39.998, 50.02),
    ];
    const result = classifyHydraulicCrossing(path, [site.barrier], [site.lock]);
    expect(result.class).toBe('legal_lock_passage');
  });

  it('E: lock nearby but does not connect sides → illegal_dam_crossing', () => {
    expect(lockConnectsBarrierSides(site.barrier, site.danglingLock)).toBe(false);
    expect(findNearbyNavigableLocks(site.barrier, [site.danglingLock]).length).toBeGreaterThan(0);
    const path = [p(40.02, 49.97), p(40.02, 50.03)]; // crest crossing east of lock notch
    const result = classifyHydraulicCrossing(path, [site.barrier], [site.danglingLock]);
    expect(result.class).toBe('illegal_dam_crossing');
  });

  it('F: synthetic unknown hydro site without place names works', () => {
    const unknown = syntheticSite('site-7f3a', 12.345, -3.21);
    const path = [
      p(12.345, -3.24),
      p(12.343, -3.214),
      p(12.343, -3.21),
      p(12.343, -3.206),
      p(12.345, -3.18),
    ];
    const hits = detectHydraulicBarrierCrossings(path, [unknown.barrier]);
    expect(hits.some((h) => h.crosses)).toBe(true);
    const result = classifyHydraulicCrossing(path, [unknown.barrier], [unknown.lock]);
    expect(result.class).toBe('legal_lock_passage');
    // Algorithm API exposes only ids — no geographic labels required.
    expect(unknown.barrier.id.startsWith('site-')).toBe(true);
  });

  it('G: Dubna-like geometry fixture (anonymous coords)', () => {
    // Crest axis roughly E–W north of the lock chamber.
    const barrier: HydraulicBarrier = {
      id: 'fixture-g-dam',
      type: 'dam',
      geometry: [
        p(37.125, 56.7395),
        p(37.137, 56.7395),
        p(37.15, 56.7395),
      ],
    };
    const lock: NavigableLock = {
      id: 'fixture-g-lock',
      boat: 'yes',
      geometry: [p(37.1374, 56.7343), p(37.1417, 56.7361)],
      approachGeometry: [
        p(37.12, 56.729),
        p(37.1374, 56.7343),
        p(37.1417, 56.7361),
        p(37.16, 56.742),
      ],
    };
    // Sparse chord across the crest (false river centerline).
    const damChord = [p(37.1, 56.73), p(37.137, 56.7395), p(37.19, 56.75)];
    const lockPath = [
      p(37.1, 56.73),
      p(37.12, 56.729),
      p(37.1374, 56.7343),
      p(37.1395, 56.7395), // cross crest at the lock longitude
      p(37.1417, 56.742),
      p(37.15, 56.75),
    ];

    expect(pathCrossesBarrier(damChord, barrier)).toBe(true);
    expect(classifyHydraulicCrossing(damChord, [barrier], [lock]).class).toBe(
      'illegal_dam_crossing',
    );
    expect(classifyHydraulicCrossing(damChord, [barrier], []).class).toBe('barrier_without_lock');

    expect(pathUsesLockPassage(lockPath, barrier, lock)).toBe(true);
    expect(classifyHydraulicCrossing(lockPath, [barrier], [lock]).class).toBe(
      'legal_lock_passage',
    );
  });

  it('H: Rybinsk-like geometry fixture (anonymous coords)', () => {
    // Crest east of locks; locks at ~38.71 connect N–S.
    const barrier: HydraulicBarrier = {
      id: 'fixture-h-dam',
      type: 'dam',
      geometry: [
        p(38.78, 58.092),
        p(38.82, 58.095),
        p(38.85, 58.098),
      ],
    };
    const lock: NavigableLock = {
      id: 'fixture-h-lock',
      boat: 'yes',
      cemT: 'VIc',
      geometry: [p(38.7083, 58.0998), p(38.7088, 58.1004)],
      approachGeometry: [
        p(38.72, 58.07),
        p(38.7283, 58.095),
        p(38.7086, 58.0999),
        p(38.65, 58.13),
      ],
    };

    const damCrossing = [
      p(38.8559, 58.049),
      p(38.821867, 58.088214),
      p(38.823371, 58.095732),
      p(38.821867, 58.104336),
      p(38.7, 58.2),
    ];
    const lockPassage = [
      p(38.8559, 58.049),
      p(38.72, 58.07),
      p(38.7283, 58.095),
      p(38.7086, 58.0999),
      p(38.65, 58.13),
      p(37.95, 59.1),
    ];

    // Crest is far from lock (~6 km) — damCrossing must not count as lock passage.
    expect(pathUsesLockPassage(damCrossing, barrier, lock)).toBe(false);
    const bad = classifyHydraulicCrossing(damCrossing, [barrier], [lock]);
    expect(['illegal_dam_crossing', 'barrier_without_lock']).toContain(bad.class);

    // Lock approach connects sides of THIS crest only if approach spans sides.
    // For a crest at lon 38.78–38.85, lock at 38.71 may be "nearby" but the
    // crossing at 38.82 is the illegal crest path.
    expect(bad.class).not.toBe('legal_lock_passage');

    // Path through lock/approach without hugging the eastern crest.
    const good = classifyHydraulicCrossing(lockPassage, [barrier], [lock]);
    expect(good.class).toBe('legal_lock_passage');
    expect(pathUsesLockPassage(lockPassage, barrier, lock)).toBe(true);
  });

  it('no_barrier when path is far from all crests', () => {
    const path = [p(10, 10), p(10.1, 10.1)];
    expect(classifyHydraulicCrossing(path, [site.barrier], [site.lock]).class).toBe('no_barrier');
  });

  it('non-navigable lock metadata is ignored', () => {
    const closed: NavigableLock = { ...site.lock, id: 'closed', boat: 'no', navigable: false };
    const path = [p(40.02, 49.97), p(40.02, 50.03)];
    expect(findNearbyNavigableLocks(site.barrier, [closed])).toHaveLength(0);
    expect(classifyHydraulicCrossing(path, [site.barrier], [closed]).class).toBe(
      'barrier_without_lock',
    );
  });

  it('I: lock merely nearby on wrong side is NOT legal', () => {
    const barrier: HydraulicBarrier = {
      id: 'wrong-side-dam',
      type: 'dam',
      geometry: [p(20, 30), p(20.05, 30), p(20.1, 30)],
    };
    // Lock sits entirely south — does not connect pools.
    const dangling: NavigableLock = {
      id: 'south-only',
      boat: 'yes',
      geometry: [p(20.05, 29.99), p(20.06, 29.991)],
      approachGeometry: [p(20.05, 29.98), p(20.05, 29.99)],
    };
    // Crest crossing east of the dangling lock.
    const path = [p(20.08, 29.97), p(20.08, 30.03)];
    expect(lockConnectsBarrierSides(barrier, dangling)).toBe(false);
    expect(pathUsesLockPassage(path, barrier, dangling)).toBe(false);
    expect(classifyHydraulicCrossing(path, [barrier], [dangling]).class).toBe(
      'illegal_dam_crossing',
    );
  });

  it('J: sparse long chord across crest is still a crossing', () => {
    const barrier: HydraulicBarrier = {
      id: 'sparse-dam',
      type: 'dam',
      geometry: [p(10, 20), p(10.08, 20), p(10.16, 20)],
    };
    // Two endpoints only, ~4 km apart, crest near the midpoint.
    const sparse = [p(10.08, 19.97), p(10.08, 20.03)];
    expect(pathCrossesBarrier(sparse, barrier)).toBe(true);
    expect(classifyHydraulicCrossing(sparse, [barrier], []).class).toBe('barrier_without_lock');
  });

  it('K: structure-band side-straddle catches tip slightly off OSM crest', () => {
    // Crest centerline south of the tip; tip ~0.45 km north — still opposite sides.
    const barrier: HydraulicBarrier = {
      id: 'offset-crest',
      type: 'dam',
      geometry: [
        p(38.857, 58.1),
        p(38.84, 58.09),
        p(38.826, 58.083),
      ],
    };
    const tipPath = [
      p(38.8559, 58.049),
      p(38.821867, 58.088214),
      p(38.823371, 58.095732),
      p(38.821867, 58.104336),
      p(38.7, 58.2),
    ];
    expect(pathCrossesBarrier(tipPath, barrier)).toBe(true);
    expect(classifyHydraulicCrossing(tipPath, [barrier], []).class).toBe('barrier_without_lock');
  });
});
