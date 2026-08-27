/**
 * E2 DATA_PILOT — research-only types.
 * Not imported by production routing (waterways / snap / validator / hydro).
 *
 * Goal: prove Russian ENC S-57 object classes can map into AquaRoute WaterGraph
 * layer types. No router is built here.
 */

export type LngLat = { lon: number; lat: number };

/** Minimal S-57 feature as decoded JSON (real .000 → JSON is out of scope). */
export type S57ObjectClass =
  | 'RECTRC'
  | 'FAIRWY'
  | 'GATCON'
  | 'LOKBSN'
  | 'DAMCON'
  | 'OBSTRN'
  | 'DEPARE'
  | 'DRGARE'
  | 'BRIDGE'
  | 'DISMAR';

export type S57Geometry =
  | { type: 'Point'; coordinates: [number, number] }
  | { type: 'LineString'; coordinates: [number, number][] }
  | { type: 'Polygon'; coordinates: [number, number][][] };

export type S57Feature = {
  /** S-57 object class acronym */
  objectClass: S57ObjectClass;
  /** Cell / folio id when known (e.g. 8R4001) */
  cellId?: string;
  geometry: S57Geometry;
  attributes: Record<string, string | number | boolean | null>;
};

export type S57Collection = {
  source: 'synthetic' | 's57' | 's63-decoded';
  folioIds: string[];
  basinLabel: string;
  features: S57Feature[];
};

/** Normalized intermediate (after parse, before WaterGraph adapter). */
export type NormalizedWaterObjectKind =
  | 'official_fairway_axis'
  | 'preferred_fairway'
  | 'lock_gate'
  | 'lock_basin'
  | 'dam_barrier'
  | 'hazard'
  | 'depth_area'
  | 'dredged_area'
  | 'bridge'
  | 'distance_mark';

export type NormalizedWaterObject = {
  kind: NormalizedWaterObjectKind;
  s57Class: S57ObjectClass;
  cellId?: string;
  geometry: S57Geometry;
  /** Human-readable attrs carried forward for WaterGraph. */
  props: {
    name?: string;
    /** Metres; DEPARE DRVAL1/DRVAL2, BRIDGE VERCLR, etc. */
    depthMinM?: number | null;
    depthMaxM?: number | null;
    verticalClearanceM?: number | null;
    /** DISMAR kilometrage along waterway */
    chainageKm?: number | null;
    restriction?: string | null;
    seasonal?: string | null;
    raw: Record<string, string | number | boolean | null>;
  };
};

/**
 * Research WaterGraph layer types — mirrors future production hybrid graph
 * without wiring into measureWaterChain.
 */
export type WaterGraphEdgeKind = 'official_axis' | 'preferred_fairway' | 'navigable_depth';

export type WaterGraphNodeKind = 'lock' | 'dam' | 'bridge' | 'hazard' | 'distance_mark' | 'junction';

export type WaterGraphEdge = {
  id: string;
  kind: WaterGraphEdgeKind;
  coords: LngLat[];
  sourceS57: S57ObjectClass;
  cellId?: string;
  depthMinM?: number | null;
  meta?: Record<string, string | number | boolean | null>;
};

export type WaterGraphNode = {
  id: string;
  kind: WaterGraphNodeKind;
  point: LngLat;
  sourceS57: S57ObjectClass;
  cellId?: string;
  verticalClearanceM?: number | null;
  chainageKm?: number | null;
  restriction?: string | null;
  meta?: Record<string, string | number | boolean | null>;
};

export type WaterGraphZone = {
  id: string;
  kind: 'depth_area' | 'dredged_area' | 'hazard_area';
  ring: LngLat[];
  sourceS57: S57ObjectClass;
  depthMinM?: number | null;
  depthMaxM?: number | null;
  cellId?: string;
};

export type WaterGraphLayerBundle = {
  edges: WaterGraphEdge[];
  nodes: WaterGraphNode[];
  zones: WaterGraphZone[];
  /** Provenance for license / audit */
  provenance: {
    folioIds: string[];
    basinLabel: string;
    source: S57Collection['source'];
    adapterVersion: string;
    generatedAt: string;
  };
  stats: {
    byS57Class: Partial<Record<S57ObjectClass, number>>;
    byEdgeKind: Partial<Record<WaterGraphEdgeKind, number>>;
    byNodeKind: Partial<Record<WaterGraphNodeKind, number>>;
  };
};

/** Future AI learning signal (design only — RouteTrace unchanged). */
export type EncAiLearningSignal = {
  chosenRouteSample?: LngLat[];
  officialFairwaySample?: LngLat[];
  distanceFromOfficialFairwayKm?: number;
  nearestOfficialHazardId?: string | null;
  nearestLockOrDamId?: string | null;
  seasonalRestriction?: string | null;
  userCorrectionNote?: string | null;
  /** Derived label for later training */
  learningHint:
    | 'on_official_fairway'
    | 'near_fairway'
    | 'off_fairway'
    | 'near_hazard'
    | 'via_lock'
    | 'unknown';
};

export const ADAPTER_VERSION = 'data-pilot-0.1.0';

/** Static S-57 → AquaRoute mapping (documentation + runtime). */
export const S57_TO_AQUAROUTE: Record<
  S57ObjectClass,
  { aquaRoute: string; waterGraph: string; priority: 'pilot' | 'later' }
> = {
  RECTRC: {
    aquaRoute: 'официальная ось судового хода',
    waterGraph: 'edge:official_axis',
    priority: 'pilot',
  },
  FAIRWY: {
    aquaRoute: 'preferred / fairway edge',
    waterGraph: 'edge:preferred_fairway',
    priority: 'pilot',
  },
  GATCON: {
    aquaRoute: 'шлюз / ворота',
    waterGraph: 'node:lock',
    priority: 'pilot',
  },
  LOKBSN: {
    aquaRoute: 'камерный бассейн шлюза',
    waterGraph: 'node:lock (basin context)',
    priority: 'pilot',
  },
  DAMCON: {
    aquaRoute: 'плотина / barrier',
    waterGraph: 'node:dam',
    priority: 'pilot',
  },
  OBSTRN: {
    aquaRoute: 'hazard / запрет',
    waterGraph: 'node|zone:hazard',
    priority: 'pilot',
  },
  DEPARE: {
    aquaRoute: 'глубины / зона',
    waterGraph: 'zone:depth_area + optional navigable_depth edge filter',
    priority: 'pilot',
  },
  DRGARE: {
    aquaRoute: 'дноуглублённый участок',
    waterGraph: 'zone:dredged_area',
    priority: 'later',
  },
  BRIDGE: {
    aquaRoute: 'мост + габарит',
    waterGraph: 'node:bridge',
    priority: 'later',
  },
  DISMAR: {
    aquaRoute: 'километраж / метаданные',
    waterGraph: 'node:distance_mark',
    priority: 'later',
  },
};
