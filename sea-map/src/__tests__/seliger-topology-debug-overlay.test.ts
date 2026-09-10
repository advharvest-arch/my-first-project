import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  countTopologyDebugLayers,
  formatTopologyConnectionPopup,
  formatTopologyWaterPopup,
  seligerTopologyDebugEnabledFromSearchParams,
  type TopologyDebugCollection,
  type TopologyDebugProps,
} from '../seliger-topology-debug';
import { seligerDebugEnabledFromSearchParams } from '../seliger-debug';

const here = dirname(fileURLToPath(import.meta.url));
const TOPO_GEOJSON = resolve(here, '../../public/seliger-topology-debug.geojson');

const FOCUS_IDS = [
  399081, 1203668, 81753515, 9617478, 9617480, 30196394, 9617479, 18072605,
  18358803, 1316976066, 20542134, 167688573, 399614, 30164445, 1159264, 17001378,
  1236637, 119343953, 1305535843, 1135420114, 49220130, 1729194, 430378915,
  16459681,
];

describe('seligerTopologyDebug overlay', () => {
  it('enables only on ?seligerTopologyDebug=1 and does not collide with seligerDebug', () => {
    expect(seligerTopologyDebugEnabledFromSearchParams('?seligerTopologyDebug=1')).toBe(true);
    expect(seligerTopologyDebugEnabledFromSearchParams('seligerTopologyDebug=1')).toBe(true);
    expect(seligerTopologyDebugEnabledFromSearchParams('?seligerTopologyDebug=true')).toBe(false);
    expect(seligerTopologyDebugEnabledFromSearchParams('?seligerDebug=1')).toBe(false);
    expect(seligerTopologyDebugEnabledFromSearchParams('')).toBe(false);
    expect(seligerDebugEnabledFromSearchParams('?seligerTopologyDebug=1')).toBe(false);
    expect(seligerDebugEnabledFromSearchParams('?seligerDebug=1')).toBe(true);
  });

  it('nameless water popup still shows OSM id', () => {
    const props: TopologyDebugProps = {
      layer: 'confirmed-feature',
      name: '',
      osm_type: 'way',
      osm_id: 1135420114,
      status: 'island-water',
      bfs_hops: null,
      tags: { natural: 'water' },
    };
    const html = formatTopologyWaterPopup(props);
    expect(html).toContain('way/1135420114');
    expect(html).toContain('OSM ID');
    expect(html).toContain('natural=water');
  });

  it('WATERWAY_CONNECTOR popup lists FROM/TO, connector way and evidence', () => {
    const html = formatTopologyConnectionPopup({
      layer: 'waterway-connector',
      connection_type: 'WATERWAY_CONNECTOR',
      from_key: 'r399081',
      to_key: 'w20542134',
      from_name: 'Селигер (r399081)',
      to_name: 'Белое (w20542134)',
      connector_osm_id: 167688573,
      shared_node_ids: [1, 2],
      shared_edge_ids: [],
      evidence: { connector: 'w167688573', why: 'canal' },
      status: 'confirmed',
    });
    expect(html).toContain('FROM: Селигер (r399081)');
    expect(html).toContain('TO: Белое (w20542134)');
    expect(html).toContain('way/167688573');
    expect(html).toContain('WATERWAY_CONNECTOR');
    expect(html).toContain('w167688573');
  });

  it('bundled visual geojson is the PR #86 graph without fake DIRECT_OSM lines', () => {
    const fc = JSON.parse(readFileSync(TOPO_GEOJSON, 'utf8')) as TopologyDebugCollection;
    const counts = countTopologyDebugLayers(fc);
    expect(counts.seedOuters).toBe(2);
    expect(counts.innerPolygons).toBe(137);
    expect(counts.outerContours).toBe(2);
    expect(counts.directOsmLines).toBe(0);
    expect(counts.waterwayConnectors).toBe(20);
    expect(fc.properties?.skipped_centroid_connection_lines).toBeGreaterThan(0);

    const focusIds = new Set(
      fc.features
        .filter((f) => f.properties.layer === 'focus-label')
        .map((f) => f.properties.osm_id),
    );
    for (const id of FOCUS_IDS) {
      expect(focusIds.has(id)).toBe(true);
    }

    const beloe = fc.features.find(
      (f) => f.properties.osm_id === 20542134 && f.properties.layer === 'confirmed-feature',
    );
    expect(beloe?.properties.status).toBe('confirmed');
    expect(beloe?.properties.in_confirmed_component).toBe(true);

    for (const id of [1305535843, 1135420114, 49220130]) {
      const feat = fc.features.find(
        (f) => f.properties.osm_id === id && f.properties.layer === 'island-water',
      );
      expect(feat).toBeTruthy();
      expect(feat?.properties.in_confirmed_component).toBe(false);
    }

    for (const id of [119343953, 430378915, 16459681, 1236637, 30196394]) {
      const feat = fc.features.find(
        (f) => f.properties.osm_id === id && f.properties.layer === 'nearby-candidate',
      );
      expect(feat).toBeTruthy();
      expect(feat?.properties.status).toBe('nearby');
      expect(feat?.properties.in_confirmed_component).toBe(false);
    }

    const divnoe = fc.features.find(
      (f) =>
        f.properties.osm_id === 1729194 &&
        (f.properties.layer === 'nearby-candidate' || f.properties.layer === 'island-water'),
    );
    expect(divnoe).toBeTruthy();
    expect(divnoe?.properties.in_confirmed_component).toBe(false);

    const canal = fc.features.find(
      (f) =>
        f.properties.layer === 'waterway-connector' &&
        f.properties.connector_osm_id === 167688573,
    );
    expect(canal).toBeTruthy();
    expect(canal?.geometry.type).toBe('LineString');
    expect(canal?.properties.from_key === 'r399081' || canal?.properties.to_key === 'r399081').toBe(
      true,
    );
    expect(
      canal?.properties.from_key === 'w20542134' || canal?.properties.to_key === 'w20542134',
    ).toBe(true);
  });
});
