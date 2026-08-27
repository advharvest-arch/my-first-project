/**
 * E1.5 OPEN RUSSIAN WATER DATA — research-only types.
 * Not imported by production routing.
 */

export type AccessType = 'public' | 'restricted' | 'paid' | 'unknown' | 'closed';

export type SourceType =
  | 'basin_admin_site'
  | 'normative_pdf'
  | 'bulletin_pdf'
  | 'disposition_pdf'
  | 'spreadsheet'
  | 'html_table'
  | 'coverage_catalog'
  | 'legal_portal'
  | 'other';

export type DataType =
  | 'enc_classifier'
  | 'enc_coverage_meta'
  | 'fairway_list'
  | 'guaranteed_dimensions'
  | 'actual_dimensions'
  | 'lock_dimensions'
  | 'bridge_clearance'
  | 'navigation_event'
  | 'seasonal_dates'
  | 'waterway_segments'
  | 'hazard_notice'
  | 'depth_forecast'
  | 'regulatory_text';

export type OpenDataSource = {
  id: string;
  name: string;
  organization: string;
  url: string;
  sourceType: SourceType;
  accessType: AccessType;
  dateChecked: string;
  updateFrequency?: string | null;
  geographicCoverage: string;
  dataType: DataType[];
  machineReadable: 'yes' | 'no' | 'partial';
  licenseProvenance: string;
  usefulForRouting: 'high' | 'medium' | 'low' | 'none';
  usefulForAI: 'high' | 'medium' | 'low' | 'none';
  reliability: 'official' | 'secondary' | 'unknown';
  notes: string;
  /** CLOSED sources must not be ingested. */
  closedReason?: string;
};

export type Provenance = {
  sourceId: string;
  sourceUrl: string;
  retrievedAt: string;
  documentDate?: string | null;
  page?: number | string | null;
  originalText: string;
  confidence: number; // 0..1
};

export type WaterFact = {
  id: string;
  basin: string;
  waterway: string;
  segment?: string | null;
  fromKm?: number | null;
  toKm?: number | null;
  restriction?: string | null;
  depthCm?: number | null;
  widthM?: number | null;
  heightM?: number | null;
  season?: string | null;
  lock?: string | null;
  barrier?: string | null;
  navigationStatus?: 'open' | 'restricted' | 'closed' | 'unknown' | null;
  guaranteedDepthCm?: number | null;
  actualDepthCm?: number | null;
  factKind:
    | 'dimension'
    | 'lock'
    | 'barrier'
    | 'restriction'
    | 'segment'
    | 'season'
    | 'hazard'
    | 'coverage_meta'
    | 'other';
  provenance: Provenance;
};

export type NavigationEvent = {
  id: string;
  waterway: string;
  locationText: string;
  eventType:
    | 'closure'
    | 'restriction'
    | 'fairway_change'
    | 'lock_repair'
    | 'depth_limit'
    | 'height_limit'
    | 'seasonal'
    | 'other';
  validFrom?: string | null;
  validTo?: string | null;
  restriction?: string | null;
  fromKm?: number | null;
  toKm?: number | null;
  provenance: Provenance;
  confidence: number;
};

/** Research-only RouteTrace extension concept (production RouteTrace unchanged). */
export type RouteTraceExternalFactRef = {
  factId: string;
  source: string;
  confidence: number;
  matchedWaterway?: string | null;
  matchedSegment?: string | null;
};

export type SourceQuality = {
  sourceId: string;
  authority: number; // 0..1
  freshness: number;
  geographicPrecision: number;
  machineReadability: number;
  provenanceScore: number;
  /** Sum / average — NOT a routing cost. */
  sourceQuality: number;
};

export type WaterGraphMetadataHint = {
  kind: 'lock_portal' | 'barrier' | 'edge_constraint' | 'edge_availability' | 'fairway_prior' | 'advisory';
  factId: string;
  summary: string;
  soft: boolean;
};

export const SCHEMA_VERSION = 'open-russian-data-0.1.0';
