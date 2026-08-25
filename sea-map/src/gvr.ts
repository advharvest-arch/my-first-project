import gvrIndex from './gvr-index.json';

/**
 * Государственный водный реестр (ГВР) — официальные названия водных объектов РФ.
 *
 * Публичного bulk-API геометрии у Росводресурсов нет; в OpenStreetMap на объекты
 * проставлены коды ГВР (`gvr:code`). Индекс code→имя собран по этим привязкам
 * и используется как источник официальных названий в AquaRoute.
 */

type GvrIndexFile = {
  source: string;
  note: string;
  byCode: Record<string, string>;
  byName: Record<string, string>;
};

const index = gvrIndex as GvrIndexFile;

/** Runtime extras learned from live Overpass along a route. */
const runtimeByCode = new Map<string, string>();
const runtimeByName = new Map<string, string>();

export function gvrSourceLabel(): string {
  return 'Государственный водный реестр (ГВР)';
}

export function normalizeGvrCode(code: string | null | undefined): string | null {
  if (!code) return null;
  const c = String(code).trim();
  return c.length >= 10 ? c : null;
}

export function rememberGvrPair(code: string | null | undefined, name: string | null | undefined): void {
  const c = normalizeGvrCode(code);
  const n = (name ?? '').trim();
  if (!c || !n) return;
  runtimeByCode.set(c, n);
  runtimeByName.set(n.toLocaleLowerCase('ru'), c);
}

export function gvrNameByCode(code: string | null | undefined): string | null {
  const c = normalizeGvrCode(code);
  if (!c) return null;
  return runtimeByCode.get(c) ?? index.byCode[c] ?? null;
}

export function gvrCodeByName(name: string | null | undefined): string | null {
  if (!name) return null;
  const key = name.trim().toLocaleLowerCase('ru');
  if (!key) return null;
  return runtimeByName.get(key) ?? index.byName[key] ?? null;
}

/**
 * Official GVR display name for an OSM/catalog label (and optional code).
 * Prefers the registry name bound to `gvr:code`.
 */
export function officialGvrName(
  osmOrCatalogName: string | null | undefined,
  gvrCode?: string | null,
): { name: string; gvrCode: string; fromGvr: true } | null {
  const code = normalizeGvrCode(gvrCode) ?? gvrCodeByName(osmOrCatalogName);
  if (code) {
    const official = gvrNameByCode(code);
    if (official) {
      rememberGvrPair(code, official);
      return { name: official, gvrCode: code, fromGvr: true };
    }
  }
  // Name known in registry without a code on the geometry yet.
  if (osmOrCatalogName) {
    const byName = gvrCodeByName(osmOrCatalogName);
    if (byName) {
      const official = gvrNameByCode(byName);
      if (official) return { name: official, gvrCode: byName, fromGvr: true };
    }
  }
  return null;
}

/** Resolve a free-text water name to the GVR spelling when possible. */
export function resolveWaterName(raw: string | null | undefined, gvrCode?: string | null): string | null {
  if (!raw && !gvrCode) return null;
  const hit = officialGvrName(raw, gvrCode);
  if (hit) return hit.name;
  return raw?.trim() || null;
}

export function gvrIndexStats(): { codes: number; names: number } {
  return {
    codes: Object.keys(index.byCode).length + runtimeByCode.size,
    names: Object.keys(index.byName).length + runtimeByName.size,
  };
}
