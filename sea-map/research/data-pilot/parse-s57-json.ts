/**
 * E2 DATA_PILOT — parse S-57-like JSON into normalized water objects.
 * Real ISO 8211 (.000) decode is deferred until a licensed cell is available.
 */

import {
  type NormalizedWaterObject,
  type NormalizedWaterObjectKind,
  type S57Collection,
  type S57Feature,
  type S57ObjectClass,
} from './types.ts';

const KIND_BY_CLASS: Record<S57ObjectClass, NormalizedWaterObjectKind> = {
  RECTRC: 'official_fairway_axis',
  FAIRWY: 'preferred_fairway',
  GATCON: 'lock_gate',
  LOKBSN: 'lock_basin',
  DAMCON: 'dam_barrier',
  OBSTRN: 'hazard',
  DEPARE: 'depth_area',
  DRGARE: 'dredged_area',
  BRIDGE: 'bridge',
  DISMAR: 'distance_mark',
};

function num(v: string | number | boolean | null | undefined): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function str(v: string | number | boolean | null | undefined): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number') return String(v);
  return undefined;
}

/** Validate and normalize a research S-57 JSON collection. */
export function parseS57Collection(raw: unknown): S57Collection {
  if (!raw || typeof raw !== 'object') {
    throw new Error('DATA_PILOT: expected S57Collection object');
  }
  const o = raw as Record<string, unknown>;
  const source = o.source;
  if (source !== 'synthetic' && source !== 's57' && source !== 's63-decoded') {
    throw new Error('DATA_PILOT: invalid source');
  }
  if (!Array.isArray(o.folioIds) || typeof o.basinLabel !== 'string' || !Array.isArray(o.features)) {
    throw new Error('DATA_PILOT: folioIds / basinLabel / features required');
  }
  const features: S57Feature[] = [];
  for (const f of o.features) {
    features.push(assertFeature(f));
  }
  return {
    source,
    folioIds: o.folioIds.map(String),
    basinLabel: o.basinLabel,
    features,
  };
}

function assertFeature(f: unknown): S57Feature {
  if (!f || typeof f !== 'object') throw new Error('DATA_PILOT: bad feature');
  const o = f as Record<string, unknown>;
  const objectClass = o.objectClass;
  if (typeof objectClass !== 'string' || !(objectClass in KIND_BY_CLASS)) {
    throw new Error(`DATA_PILOT: unsupported objectClass ${String(objectClass)}`);
  }
  if (!o.geometry || typeof o.geometry !== 'object') {
    throw new Error('DATA_PILOT: feature.geometry required');
  }
  const g = o.geometry as Record<string, unknown>;
  if (g.type !== 'Point' && g.type !== 'LineString' && g.type !== 'Polygon') {
    throw new Error(`DATA_PILOT: bad geometry type ${String(g.type)}`);
  }
  return {
    objectClass: objectClass as S57ObjectClass,
    cellId: typeof o.cellId === 'string' ? o.cellId : undefined,
    geometry: o.geometry as S57Feature['geometry'],
    attributes:
      o.attributes && typeof o.attributes === 'object'
        ? (o.attributes as S57Feature['attributes'])
        : {},
  };
}

/** Map each S-57 feature into a normalized AquaRoute-oriented object. */
export function normalizeFeatures(collection: S57Collection): NormalizedWaterObject[] {
  return collection.features.map((f) => normalizeOne(f));
}

function normalizeOne(f: S57Feature): NormalizedWaterObject {
  const a = f.attributes;
  return {
    kind: KIND_BY_CLASS[f.objectClass],
    s57Class: f.objectClass,
    cellId: f.cellId,
    geometry: f.geometry,
    props: {
      name: str(a.OBJNAM ?? a.name),
      depthMinM: num(a.DRVAL1 ?? a.depthMinM),
      depthMaxM: num(a.DRVAL2 ?? a.depthMaxM),
      verticalClearanceM: num(a.VERCLR ?? a.verticalClearanceM),
      chainageKm: num(a.disver ?? a.chainageKm),
      restriction: str(a.RESTRN ?? a.restriction) ?? null,
      seasonal: str(a.PERSTA ?? a.seasonal) ?? null,
      raw: { ...a },
    },
  };
}

/** Classes required for the minimal DATA_PILOT proof. */
export const PILOT_REQUIRED_CLASSES: S57ObjectClass[] = [
  'RECTRC',
  'FAIRWY',
  'GATCON',
  'DAMCON',
  'OBSTRN',
  'DEPARE',
];

export function coverageReport(collection: S57Collection): {
  present: S57ObjectClass[];
  missingRequired: S57ObjectClass[];
  counts: Partial<Record<S57ObjectClass, number>>;
} {
  const counts: Partial<Record<S57ObjectClass, number>> = {};
  for (const f of collection.features) {
    counts[f.objectClass] = (counts[f.objectClass] ?? 0) + 1;
  }
  const present = Object.keys(counts) as S57ObjectClass[];
  const missingRequired = PILOT_REQUIRED_CLASSES.filter((c) => !counts[c]);
  return { present, missingRequired, counts };
}
