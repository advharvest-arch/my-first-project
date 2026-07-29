import { haversineKm, pathLengthKm, type LngLat } from './geo';

export type BrouterResult = {
  points: LngLat[];
  lengthKm: number;
  wayTags: string[];
};

const BROUTER_URL = 'https://brouter.de/brouter';

/**
 * Public brouter.de often kills long one-shot river searches (watchdog).
 * We try once, then bisect — halves usually succeed with a near-optimal path.
 */
const LONG_SPAN_KM = 200;
const MAX_SPLIT_DEPTH = 6;

/**
 * Upper Volga only (Селигер / исток). Including these on Чебоксары→Онега
 * pulls the track upstream via Селижаровка instead of Волго-Балт.
 */
const VOLGA_UPPER_VIAS: LngLat[] = [
  { lon: 33.45, lat: 56.85 }, // Селижарово
  { lon: 35.92, lat: 56.86 }, // Тверь
];

/**
 * Navigable Volga chain, west → east (Селижарово → Куйбышев).
 * Vias are sliced from this order so Куйбышев→Иваньково never visits
 * the Moscow Canal before Горьковское.
 */
const VOLGA_STEM_CHAIN: LngLat[] = [
  { lon: 33.45, lat: 56.85 }, // Селижарово
  { lon: 35.92, lat: 56.86 }, // Тверь
  { lon: 37.1388, lat: 56.7346 }, // Дубна / шлюз №1 Иваньковского гидроузла
  { lon: 38.33, lat: 57.53 }, // Углич
  { lon: 38.7086, lat: 58.0999 }, // Рыбинск / шлюзы №11–12
  { lon: 39.89, lat: 57.63 }, // Ярославль
  { lon: 40.93, lat: 57.77 }, // Кострома
  { lon: 42.13, lat: 57.44 }, // Кинешма
  { lon: 43.47, lat: 56.65 }, // Городец
  { lon: 44.0, lat: 56.33 }, // Нижний Новгород
  { lon: 45.05, lat: 56.15 }, // Волга ниже устья Ветлуги
  { lon: 47.25, lat: 56.15 }, // Чебоксары
  { lon: 49.05, lat: 55.5 }, // Казань / Куйбышев (север)
];

/**
 * Dense navigable fairway Dubna → Рыбинск → НН → Чебоксары → Казань → южный Куйбышев.
 * Open-reservoir clicks often collapse in BRouter; snap onto these pins.
 * Dam crossings must go through the shipping locks (not across the crest).
 */
const VOLGA_NAV_FAIRWAY: LngLat[] = [
  // Дубна: только через шлюз №1 (не по автодороге/гребню плотины)
  { lon: 37.100, lat: 56.750 }, // верхний бьеф, подход
  { lon: 37.118, lat: 56.743 },
  { lon: 37.130, lat: 56.737 }, // подходной канал
  { lon: 37.1388, lat: 56.7346 }, // камера шлюза №1
  { lon: 37.148, lat: 56.731 }, // нижняя голова
  { lon: 37.162, lat: 56.733 }, // нижний канал
  { lon: 37.180, lat: 56.748 }, // Волга восточнее плотины
  { lon: 37.220, lat: 56.785 },
  { lon: 37.4682, lat: 56.8998 },
  { lon: 37.6136, lat: 57.1196 },
  { lon: 37.8525, lat: 57.2466 },
  { lon: 38.1256, lat: 57.4176 },
  { lon: 38.3805, lat: 57.612 },
  { lon: 38.4964, lat: 57.8509 },
  { lon: 38.65, lat: 58.13 }, // Рыбинское вдхр., подход к шлюзам
  { lon: 38.7086, lat: 58.0999 }, // шлюзы №11–12 (Переборы)
  { lon: 38.72, lat: 58.07 }, // нижний бьеф Рыбинска
  { lon: 38.95, lat: 58.06 }, // Волга ниже шлюза
  { lon: 39.14, lat: 58.027 },
  { lon: 39.524, lat: 57.882 },
  { lon: 39.8135, lat: 57.6987 },
  { lon: 40.161, lat: 57.5724 },
  { lon: 40.4924, lat: 57.747 },
  { lon: 40.9543, lat: 57.7384 },
  { lon: 41.1453, lat: 57.5048 },
  { lon: 41.5907, lat: 57.4457 },
  { lon: 41.965, lat: 57.4826 },
  { lon: 42.4227, lat: 57.4462 },
  { lon: 42.8666, lat: 57.3755 },
  { lon: 43.1197, lat: 57.2586 },
  { lon: 43.1887, lat: 57.0009 },
  { lon: 43.3268, lat: 56.7298 },
  { lon: 43.6153, lat: 56.5024 },
  { lon: 43.9575, lat: 56.3438 },
  { lon: 44.2223, lat: 56.1647 },
  { lon: 44.636, lat: 56.0475 },
  { lon: 45.1, lat: 56.084 },
  { lon: 45.4713, lat: 56.1013 },
  { lon: 45.8937, lat: 56.1862 },
  { lon: 46.228, lat: 56.2575 },
  { lon: 46.6684, lat: 56.3286 },
  { lon: 46.998, lat: 56.138 },
  { lon: 47.2562, lat: 56.1626 },
  { lon: 47.6005, lat: 56.1263 },
  { lon: 47.907, lat: 56.0792 },
  { lon: 48.119, lat: 55.9248 },
  { lon: 48.3767, lat: 55.8272 },
  { lon: 48.745, lat: 55.8103 },
  { lon: 49.0526, lat: 55.7514 },
  { lon: 49.0122, lat: 55.5609 },
  { lon: 49.1353, lat: 55.3667 },
  { lon: 49.3566, lat: 55.1957 },
  { lon: 49.0862, lat: 55.0666 },
  { lon: 48.8862, lat: 54.9079 },
  { lon: 48.8714, lat: 54.6541 },
  { lon: 48.6151, lat: 54.5273 },
  { lon: 48.4147, lat: 54.3725 },
  { lon: 48.5117, lat: 54.1772 },
  { lon: 48.7867, lat: 54.0345 },
  { lon: 48.996, lat: 53.8776 },
  { lon: 48.9606, lat: 53.675 },
  { lon: 49.1121, lat: 53.4654 },
  { lon: 49.4463, lat: 53.4552 },
  { lon: 49.4657, lat: 53.4672 },
];

/**
 * Топозеро → Софьянга (Софпорог) → Пяозеро (Кумское вдхр., Карелия).
 * Open lake water has almost no BRouter river centerline — snap + synthetic.
 */
const TOPO_PYAOZERO_FAIRWAY: LngLat[] = [
  { lon: 32.4, lat: 65.55 },
  { lon: 32.1, lat: 65.62 },
  { lon: 31.8, lat: 65.7 },
  { lon: 31.55, lat: 65.78 },
  { lon: 31.4358, lat: 65.7981 }, // Софьянга / выход из Топозера
  { lon: 31.35, lat: 65.83 },
  { lon: 31.2417, lat: 65.8706 }, // вход в Пяозеро
  { lon: 31.15, lat: 65.95 },
  { lon: 31.05, lat: 66.05 },
  { lon: 30.95, lat: 66.15 },
];

const REGIONAL_FAIRWAYS: LngLat[][] = [VOLGA_NAV_FAIRWAY, TOPO_PYAOZERO_FAIRWAY];

/**
 * Волго-Балт north of Рыбинск (Шексна → … → Нева).
 */
const VOLGA_BALTIC_NORTH_VIAS: LngLat[] = [
  { lon: 37.95, lat: 59.1 }, // Череповец
  { lon: 37.78, lat: 60.03 }, // Белозерск
  { lon: 36.55, lat: 60.85 }, // Ковжа
  { lon: 36.35, lat: 60.98 }, // устье Вытегры → Онега
  { lon: 34.5, lat: 61.0 }, // к истоку Свири
  { lon: 33.5, lat: 60.75 }, // верхняя Свирь
  { lon: 32.7, lat: 60.5 }, // средняя Свирь
  { lon: 32.2, lat: 60.35 }, // нижняя Свирь
  { lon: 31.5, lat: 60.1 }, // Ладога
  { lon: 31.03, lat: 59.95 }, // Шлиссельбург / Нева
];

/**
 * Moscow Canal fairway into the Volga cascade (Химки → Дубна).
 */
const MOSCOW_CANAL_VIAS: LngLat[] = [
  { lon: 37.455, lat: 55.91 }, // Химкинское (судовой ход)
  { lon: 37.48, lat: 56.15 }, // Икша
  { lon: 37.51, lat: 56.35 }, // Дмитров
  { lon: 37.1388, lat: 56.7346 }, // Дубна / шлюз №1
];

/** Shipping lock №1 (Дубна) — Volga cascade must pass the chamber, not the dam road. */
const DUBNA_LOCK: LngLat = { lon: 37.1388, lat: 56.7346 };
const RYBINSK_LOCK: LngLat = { lon: 38.7086, lat: 58.0999 };

/** Dense corridor through шлюз №1 (upper approach → chamber → lower Volga). */
const DUBNA_LOCK_CORRIDOR: LngLat[] = [
  { lon: 37.100, lat: 56.750 },
  { lon: 37.118, lat: 56.743 },
  { lon: 37.130, lat: 56.737 },
  { lon: 37.1388, lat: 56.7346 }, // камера
  { lon: 37.148, lat: 56.731 }, // нижняя голова (южнее автодороги по плотине)
  { lon: 37.162, lat: 56.733 }, // нижний канал
  { lon: 37.180, lat: 56.748 }, // выход в Волгу восточнее плотины
  { lon: 37.220, lat: 56.785 },
];

/** Auto road / crest of Иваньковская плотина (north of lock №1 chamber). */
function onDubnaDamCrest(p: LngLat): boolean {
  return p.lon >= 37.145 && p.lon <= 37.172 && p.lat >= 56.742 && p.lat <= 56.755;
}

function crossesDubnaBarrier(points: LngLat[]): boolean {
  let west = false;
  let east = false;
  for (const p of points) {
    if (p.lat < 56.65 || p.lat > 56.92) continue;
    if (p.lon <= 37.12) west = true;
    if (p.lon >= 37.18) east = true;
  }
  return west && east;
}

function dubnaDamCrestKm(points: LngLat[]): number {
  let km = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (onDubnaDamCrest(a) || onDubnaDamCrest(b)) km += haversineKm(a, b);
  }
  return km;
}

function passesDubnaLockProperly(points: LngLat[]): boolean {
  if (!points.some((p) => haversineKm(p, DUBNA_LOCK) <= 0.3)) return false;
  // Road across the dam is never a valid ship track.
  if (dubnaDamCrestKm(points) > 0.15) return false;
  const upper = points.some(
    (p) => p.lon >= 37.09 && p.lon <= 37.135 && p.lat >= 56.73 && p.lat <= 56.76,
  );
  const lower = points.some(
    (p) => p.lon >= 37.145 && p.lon <= 37.22 && p.lat >= 56.728 && p.lat <= 56.78,
  );
  return upper && lower;
}

/**
 * If BRouter crossed Иваньково on the dam crest / road, splice the lock corridor in.
 */
function repairDubnaLockPassage(points: LngLat[]): LngLat[] {
  if (points.length < 2 || !crossesDubnaBarrier(points)) return points;
  if (passesDubnaLockProperly(points)) return points;

  const WEST = 37.125;
  const EAST = 37.175;
  const inLat = (p: LngLat) => p.lat >= 56.65 && p.lat <= 56.92;

  const band = points
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => inLat(p) && p.lon >= 36.9 && p.lon <= 37.5);
  if (band.length < 2) return points;
  const eastbound = band[band.length - 1]!.p.lon >= band[0]!.p.lon;

  let iIn = -1;
  let iOut = -1;
  if (eastbound) {
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      if (inLat(p) && p.lon <= WEST) iIn = i;
    }
    for (let i = iIn + 1; i < points.length; i++) {
      const p = points[i]!;
      if (inLat(p) && p.lon >= EAST) {
        iOut = i;
        break;
      }
    }
  } else {
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      if (inLat(p) && p.lon >= EAST) iIn = i;
    }
    for (let i = iIn + 1; i < points.length; i++) {
      const p = points[i]!;
      if (inLat(p) && p.lon <= WEST) {
        iOut = i;
        break;
      }
    }
  }
  if (iIn < 0 || iOut < 0 || iOut <= iIn) return points;

  const corridor = eastbound
    ? DUBNA_LOCK_CORRIDOR
    : DUBNA_LOCK_CORRIDOR.slice().reverse();
  return [...points.slice(0, iIn + 1), ...corridor, ...points.slice(iOut)];
}

/**
 * Path crosses Иваньковская плотина without a proper lock №1 passage.
 */
function looksLikeSkippingDubnaLock(points: LngLat[]): boolean {
  if (!crossesDubnaBarrier(points)) return false;
  return !passesDubnaLockProperly(points);
}

/** Кама / Белая (Н. Челны → Уфа → Белорецк) — east of the Volga stem end. */
const KAMA_BELAYA_VIAS: LngLat[] = [
  { lon: 49.05, lat: 55.5 }, // Казань / устье Камы
  { lon: 50.2, lat: 55.65 }, // Кама ниже Казани
  { lon: 52.0, lat: 55.72 }, // Нижнекамск
  { lon: 53.95, lat: 55.88 }, // устье Белой
  { lon: 54.85, lat: 55.48 }, // Дюртюли
  { lon: 55.95, lat: 54.74 }, // Уфа
  { lon: 55.95, lat: 53.65 }, // Стерлитамак
  { lon: 57.05, lat: 53.05 }, // верхняя Белая
  { lon: 58.2, lat: 53.85 }, // к Белорецку
];

/**
 * Full Moscow ↔ St. Petersburg inland waterway order.
 */
const VOLGA_BALTIC_VIAS: LngLat[] = [
  ...MOSCOW_CANAL_VIAS,
  { lon: 38.33, lat: 57.53 }, // Углич
  { lon: 38.5, lat: 58.05 }, // Рыбинск / Шексна
  ...VOLGA_BALTIC_NORTH_VIAS,
];

/**
 * BRouter's river graph often leaves the Moscow Canal shipping fairway and loops
 * east through Пироговское / Пестовское / Клязьминское before rejoining near Iksha.
 * Replace that spur with the main-stem canal corridor.
 *
 * IMPORTANT: lonMax is required. Without it, every Volga point with
 * lon≥37.545 and lat∈[55.9,56.14] (Чебоксары/Куйбышев!) matched as a "spur"
 * and got rewritten through the Moscow Canal → 10× bogus length → route fail.
 */
const MOSCOW_CANAL_EAST_SPUR = {
  lonMin: 37.545,
  lonMax: 37.88,
  latMin: 55.9,
  latMax: 56.14,
};

/** Curated fairway between the spur entry and Iksha. */
const MOSCOW_CANAL_FAIRWAY: LngLat[] = [
  { lon: 37.52, lat: 55.97 },
  { lon: 37.505, lat: 56.02 },
  { lon: 37.505, lat: 56.07 },
  { lon: 37.51, lat: 56.12 },
  { lon: 37.512, lat: 56.15 },
];

function inMoscowCanalEastSpur(p: LngLat): boolean {
  return (
    p.lon >= MOSCOW_CANAL_EAST_SPUR.lonMin &&
    p.lon <= MOSCOW_CANAL_EAST_SPUR.lonMax &&
    p.lat >= MOSCOW_CANAL_EAST_SPUR.latMin &&
    p.lat <= MOSCOW_CANAL_EAST_SPUR.latMax
  );
}

function interpolatePoints(a: LngLat, b: LngLat, n: number): LngLat[] {
  if (n <= 0) return [];
  const out: LngLat[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    out.push({ lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t });
  }
  return out;
}

/**
 * Cut Пироговское/Пестовское/Клязьминское loops off Moscow→Dubna legs.
 */
export function repairMoscowCanalEastSpur(points: LngLat[]): LngLat[] {
  if (points.length < 8) return points;

  let spurStart = -1;
  let spurEnd = -1;
  for (let i = 0; i < points.length; i++) {
    if (inMoscowCanalEastSpur(points[i]!)) {
      if (spurStart < 0) spurStart = i;
      spurEnd = i;
    } else if (spurStart >= 0 && points[i]!.lat > MOSCOW_CANAL_EAST_SPUR.latMax) {
      break;
    }
  }
  if (spurStart < 0 || spurEnd <= spurStart) return points;

  // Anchor just before the track turns east off the fairway.
  let left = Math.max(0, spurStart - 1);
  while (left > 0 && points[left]!.lon > 37.53 && points[left]!.lat < 56.05) {
    left -= 1;
  }
  // Rejoin on the canal near Iksha (west of the reservoirs).
  let right = Math.min(points.length - 1, spurEnd + 1);
  while (
    right < points.length - 1 &&
    (points[right]!.lon > 37.54 || points[right]!.lat < 56.13)
  ) {
    right += 1;
  }

  if (right <= left + 1) return points;

  const before = points.slice(0, left + 1);
  const after = points.slice(right);
  const a = before[before.length - 1]!;
  const b = after[0]!;

  const fairway = MOSCOW_CANAL_FAIRWAY.filter(
    (p) => p.lat > a.lat + 0.005 && p.lat < b.lat - 0.005,
  );
  const bridge: LngLat[] = [];
  let prev = a;
  for (const p of fairway) {
    bridge.push(...interpolatePoints(prev, p, 2), p);
    prev = p;
  }
  bridge.push(...interpolatePoints(prev, b, 2));

  return [...before, ...bridge, ...after];
}

function finalizeBrouterResult(result: BrouterResult): BrouterResult {
  const points = repairMoscowCanalEastSpur(result.points);
  if (points === result.points) return result;
  return {
    ...result,
    points,
    lengthKm: pathLengthKm(points),
  };
}

function nearMoscow(p: LngLat): boolean {
  return p.lat >= 55.4 && p.lat <= 56.35 && p.lon >= 36.9 && p.lon <= 38.1;
}

function nearSpb(p: LngLat): boolean {
  return p.lat >= 59.55 && p.lat <= 60.25 && p.lon >= 29.4 && p.lon <= 31.2;
}

/** Селигер / верхняя Волга (west of Tver). */
function nearUpperVolga(p: LngLat): boolean {
  return p.lat >= 56.55 && p.lat <= 57.7 && p.lon >= 32.4 && p.lon <= 36.2;
}

/** Онега / Ладога / Нева / Белозерский участок Волго-Балта. */
function nearNorthwestWaterway(p: LngLat): boolean {
  if (nearSpb(p)) return true;
  // Ладога
  if (p.lat >= 59.7 && p.lat <= 61.8 && p.lon >= 29.5 && p.lon <= 33.5) return true;
  // Онега
  if (p.lat >= 60.5 && p.lat <= 63.0 && p.lon >= 33.8 && p.lon <= 37.0) return true;
  // Белое / Ковжа / Вытегра
  if (p.lat >= 59.7 && p.lat <= 61.2 && p.lon >= 35.5 && p.lon <= 38.2) return true;
  // Шексна / Череповец — north of Рыбинское itself (avoid misclassifying the reservoir).
  if (p.lat >= 59.12 && p.lat <= 60.3 && p.lon >= 37.4 && p.lon <= 38.7) return true;
  return false;
}

/** Волга basin including all of Рыбинское водохранилище. */
function inVolgaBasin(p: LngLat): boolean {
  return p.lat >= 52.8 && p.lat <= 59.15 && p.lon >= 32.5 && p.lon <= 52.5;
}

/** Волга below Dubna / mid cascade (incl. Куйбышев south arm). */
function nearVolgaCascade(p: LngLat): boolean {
  return p.lat >= 52.8 && p.lat <= 59.15 && p.lon >= 37.0 && p.lon <= 52.5;
}

/** Кама basin + Белая up to Белорецк (east of Volga stem). */
function nearKamaBelaya(p: LngLat): boolean {
  return p.lat >= 52.8 && p.lat <= 60.6 && p.lon >= 48.5 && p.lon <= 59.5;
}

function isMoscowSpbCorridor(a: LngLat, b: LngLat): boolean {
  return (nearMoscow(a) && nearSpb(b)) || (nearMoscow(b) && nearSpb(a));
}

/**
 * One end on NW waterway (Онега/Ладога/СПб…), the other on Volga cascade /
 * Moscow / Kama–Belaya. Must NOT use Селижарово/Дубна — go Рыбинск → Шексна.
 */
function isVolgaBalticLongCorridor(a: LngLat, b: LngLat): boolean {
  if (isMoscowSpbCorridor(a, b)) return true;
  const nwA = nearNorthwestWaterway(a);
  const nwB = nearNorthwestWaterway(b);
  if (nwA === nwB) return false;
  const other = nwA ? b : a;
  return (
    nearVolgaCascade(other) ||
    nearMoscow(other) ||
    nearUpperVolga(other) ||
    nearKamaBelaya(other)
  );
}

/** Hop along the Volga cascade (no Волго-Балт / no pure Moscow Canal). */
function isVolgaStemCorridor(a: LngLat, b: LngLat): boolean {
  if (isVolgaBalticLongCorridor(a, b) || isMoscowSpbCorridor(a, b)) return false;
  if (!inVolgaBasin(a) || !inVolgaBasin(b)) return false;
  const span = haversineKm(a, b);
  if (span < 18) return false;
  const ia = nearestStemIndex(a);
  const ib = nearestStemIndex(b);
  // Distinct cascade waterbodies — always pin the fairway (even ~20–80 km hops).
  // Otherwise BRouter returns a land chord labeled as Куйбышевское—Чебоксарское.
  if (ia !== ib) return true;
  return span >= 80 && Math.abs(a.lon - b.lon) >= 1;
}

function pickViasAlong(
  a: LngLat,
  b: LngLat,
  pool: LngLat[],
  opts: { preserveOrder?: boolean } = {},
): LngLat[] {
  const minLon = Math.min(a.lon, b.lon);
  const maxLon = Math.max(a.lon, b.lon);
  const minLat = Math.min(a.lat, b.lat);
  const maxLat = Math.max(a.lat, b.lat);

  const vias = pool.filter((v) => {
    if (haversineKm(a, v) < 30 || haversineKm(b, v) < 30) return false;
    return (
      v.lon >= minLon - 2.2 &&
      v.lon <= maxLon + 2.2 &&
      v.lat >= minLat - 1.0 &&
      v.lat <= maxLat + 2.5
    );
  });

  if (opts.preserveOrder) return vias;

  const eastbound = b.lon >= a.lon;
  vias.sort((p, q) => (eastbound ? p.lon - q.lon : q.lon - p.lon));
  return vias;
}

/** Онега basin (not Ладога / СПб). */
function nearOnega(p: LngLat): boolean {
  return p.lat >= 60.5 && p.lat <= 63.0 && p.lon >= 33.8 && p.lon <= 37.0;
}

function nearLadoga(p: LngLat): boolean {
  return p.lat >= 59.7 && p.lat <= 61.8 && p.lon >= 29.5 && p.lon <= 33.5;
}

function nearestStemIndex(p: LngLat): number {
  // Prefer the reservoir the point actually sits in (south Rybinsk must not
  // snap to Углич just because that via is slightly closer).
  // Indices in VOLGA_STEM_CHAIN: Углич=3, Рыбинск=4.
  if (p.lat >= 57.75 && p.lat <= 59.1 && p.lon >= 37.55 && p.lon <= 39.25) {
    return 4;
  }
  if (p.lat >= 56.88 && p.lat <= 57.68 && p.lon >= 37.55 && p.lon <= 38.45) {
    return 3;
  }

  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < VOLGA_STEM_CHAIN.length; i++) {
    const d = haversineKm(p, VOLGA_STEM_CHAIN[i]!);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Vias along the Volga fairway between A and B, in travel order.
 * Optional Moscow Canal tail when an endpoint is near Moscow.
 */
function volgaStemCorridorVias(a: LngLat, b: LngLat): LngLat[] {
  const ia = nearestStemIndex(a);
  const ib = nearestStemIndex(b);
  if (ia === ib) return [];

  const lo = Math.min(ia, ib);
  const hi = Math.max(ia, ib);
  let slice = VOLGA_STEM_CHAIN.slice(lo, hi + 1);

  // Keep Селижарово/Тверь only when an endpoint is on the upper Volga.
  if (!nearUpperVolga(a) && !nearUpperVolga(b)) {
    slice = slice.filter((v) => v.lon >= 36.8);
  }

  if (ia > ib) slice = slice.slice().reverse();

  const keepLockPin = (v: LngLat) =>
    haversineKm(v, DUBNA_LOCK) < 1.5 || haversineKm(v, RYBINSK_LOCK) < 1.5;

  const vias = slice.filter(
    (v) => keepLockPin(v) || (haversineKm(a, v) >= 30 && haversineKm(b, v) >= 30),
  );

  // Prefer dense fairway pins between stem indices (more reliable than a
  // crude mid-interpolate that collapses on open reservoirs).
  const fa = nearestFairwayIndex(a);
  const fb = nearestFairwayIndex(b);
  if (fa.dist <= 100 && fb.dist <= 100 && fa.idx !== fb.idx) {
    const fair = fairwaySliceBetween(fa.idx, fb.idx).filter(
      (v) => keepLockPin(v) || (haversineKm(a, v) >= 20 && haversineKm(b, v) >= 20),
    );
    // Always pin the full Dubna lock corridor when the span crosses Иваньково.
    const spanCrossesDubna =
      Math.min(a.lon, b.lon) <= 37.12 && Math.max(a.lon, b.lon) >= 37.18;
    if (spanCrossesDubna) {
      for (const v of DUBNA_LOCK_CORRIDOR) {
        if (!fair.some((m) => haversineKm(m, v) < 0.4)) fair.push(v);
      }
    }
    if (fair.length) {
      const merged = [...vias];
      for (const v of fair) {
        if (!merged.some((m) => haversineKm(m, v) < 8)) merged.push(v);
      }
      // Keep travel order along lon for east/west Volga.
      const eastbound = b.lon >= a.lon;
      merged.sort((p, q) => (eastbound ? p.lon - q.lon : q.lon - p.lon));
      if (nearMoscow(a) || nearMoscow(b)) {
        const canal = pickViasAlong(a, b, MOSCOW_CANAL_VIAS, { preserveOrder: true });
        if (nearMoscow(b)) return [...merged, ...canal];
        return [...canal.slice().reverse(), ...merged];
      }
      return thinVias(merged, 10);
    }
  }

  const span = haversineKm(a, b);
  if (!vias.length && Math.abs(ia - ib) >= 1 && slice.length >= 2 && span >= 55) {
    const mid = interpolate(slice[0]!, slice[slice.length - 1]!, 0.5);
    if (haversineKm(a, mid) >= 6 && haversineKm(b, mid) >= 6) {
      vias.push(mid);
    }
  }

  // Moscow is off the stem chain — pin the canal fairway at the Moscow end.
  if (nearMoscow(a) || nearMoscow(b)) {
    const canal = pickViasAlong(a, b, MOSCOW_CANAL_VIAS, { preserveOrder: true });
    if (nearMoscow(b)) return [...vias, ...canal];
    return [...canal.slice().reverse(), ...vias];
  }

  return vias;
}

/**
 * Ordered Volga→Baltic chain between A and B (or reverse).
 * From the Volga/Moscow/Kama end: cascade toward Рыбинск, then Шексна→…→Neva.
 * Never prepend Дубна/Селижарово when the start is already east on the cascade.
 */
function volgaBalticCorridorVias(a: LngLat, b: LngLat): LngLat[] {
  const nwIsB = nearNorthwestWaterway(b);
  const from = nwIsB ? a : b;
  const to = nwIsB ? b : a;

  const towardRybinsk: LngLat[] = [];
  const rybinsk = { lon: 38.7086, lat: 58.0999 };

  if (nearMoscow(from)) {
    towardRybinsk.push(...MOSCOW_CANAL_VIAS);
    towardRybinsk.push(
      { lon: 38.33, lat: 57.53 }, // Углич
      rybinsk,
    );
  } else if (nearUpperVolga(from)) {
    towardRybinsk.push(...VOLGA_UPPER_VIAS);
    towardRybinsk.push(
      DUBNA_LOCK, // шлюз №1, не хорда через плотину
      { lon: 38.33, lat: 57.53 }, // Углич
      rybinsk,
    );
  } else if (nearKamaBelaya(from) && !nearVolgaCascade(from)) {
    // Белорецк / Белая / верхняя Кама: pin Kama–Belaya westbound, then Volga to Рыбинск.
    const kb = pickViasAlong(from, rybinsk, KAMA_BELAYA_VIAS, { preserveOrder: true });
    towardRybinsk.push(...kb.slice().reverse());
    const kazan = { lon: 49.05, lat: 55.5 };
    towardRybinsk.push(...volgaStemCorridorVias(kazan, rybinsk));
  } else {
    // Walk the stem chain from `from` toward Рыбинск (no Дубна if already east).
    const stem = volgaStemCorridorVias(from, rybinsk);
    towardRybinsk.push(...stem);
  }

  // Trim the northern branch to the destination — don't continue past Онега to Ладога.
  let north = [...VOLGA_BALTIC_NORTH_VIAS];
  if (nearOnega(to) && !nearLadoga(to) && !nearSpb(to)) {
    north = north.filter((v) => v.lon >= 35.8); // stop at Ковжа / вход в Онегу
  } else if (nearLadoga(to) && !nearSpb(to)) {
    north = north.filter((v) => v.lat >= 59.0); // keep through Ладога, drop Нева if far
  }

  const pool = [...towardRybinsk, ...north];

  const seen = new Set<string>();
  const ordered: LngLat[] = [];
  for (const v of pool) {
    const key = `${v.lon.toFixed(2)},${v.lat.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(v);
  }

  const vias = pickViasAlong(from, to, ordered, { preserveOrder: true });
  return nwIsB ? vias : vias.slice().reverse();
}

function corridorViasBetween(a: LngLat, b: LngLat): LngLat[] {
  const span = haversineKm(a, b);

  if (isMoscowSpbCorridor(a, b)) {
    if (span < 250) return [];
    const forward = nearMoscow(a) && nearSpb(b);
    const vias = pickViasAlong(a, b, VOLGA_BALTIC_VIAS, { preserveOrder: true });
    return forward ? vias : vias.slice().reverse();
  }

  if (isVolgaBalticLongCorridor(a, b)) {
    if (span < 250) return [];
    return volgaBalticCorridorVias(a, b);
  }

  if (isVolgaStemCorridor(a, b)) {
    return volgaStemCorridorVias(a, b);
  }

  // NW waterway involved but not classified above — never fall through to
  // Volga stem (that snaps СПб→Селижарово/Дубна). Prefer Baltic chain.
  if (nearNorthwestWaterway(a) || nearNorthwestWaterway(b)) {
    if (span < 250) return [];
    return volgaBalticCorridorVias(a, b);
  }

  const minLon = Math.min(a.lon, b.lon);
  const maxLon = Math.max(a.lon, b.lon);
  if (span < 250 || maxLon - minLon < 4) return [];
  if (maxLon < 39 || minLon > 50) return [];
  if (maxLon < 32 || Math.max(a.lat, b.lat) < 54 || Math.min(a.lat, b.lat) > 61) return [];

  return volgaStemCorridorVias(a, b);
}

function parseWayTags(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function routeSpanKm(waypoints: LngLat[]): number {
  if (waypoints.length < 2) return 0;
  let chain = 0;
  let farthest = 0;
  const a0 = waypoints[0]!;
  for (let i = 1; i < waypoints.length; i++) {
    chain += haversineKm(waypoints[i - 1]!, waypoints[i]!);
    farthest = Math.max(farthest, haversineKm(a0, waypoints[i]!));
  }
  return Math.max(chain, farthest);
}

function brouterTimeoutMs(spanKm: number): number {
  // Multi-via Volga corridors need headroom; public server often finishes in <5s
  // when vias are set, but watchdog kills under-timeout client aborts.
  return Math.min(120_000, Math.max(20_000, 15_000 + spanKm * 40));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flattenCoords(geometry: {
  type?: string;
  coordinates?: number[][] | number[][][];
}): LngLat[] | null {
  const coords = geometry.coordinates;
  if (!coords || !coords.length) return null;
  if (geometry.type === 'MultiLineString') {
    const out: LngLat[] = [];
    for (const line of coords as number[][][]) {
      for (const c of line) {
        const lon = c[0]!;
        const lat = c[1]!;
        const last = out[out.length - 1];
        if (last && last.lon === lon && last.lat === lat) continue;
        out.push({ lon, lat });
      }
    }
    return out.length >= 2 ? out : null;
  }
  const line = coords as number[][];
  if (line.length < 2) return null;
  return line.map((c) => ({ lon: c[0]!, lat: c[1]! }));
}

function parseBrouterPayload(text: string): BrouterResult | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('operation killed') || trimmed.startsWith('<')) {
    return null;
  }
  let data: {
    features?: Array<{
      geometry?: { type?: string; coordinates?: number[][] | number[][][] };
      properties?: {
        'track-length'?: string | number;
        messages?: string[][];
      };
    }>;
  };
  try {
    data = JSON.parse(trimmed) as typeof data;
  } catch {
    return null;
  }
  const feature = data.features?.[0];
  if (!feature?.geometry) return null;
  const points = flattenCoords(feature.geometry);
  if (!points || points.length < 2) return null;

  const trackM = Number(feature.properties?.['track-length']);
  let lengthKm = Number.isFinite(trackM) && trackM > 0 ? trackM / 1000 : 0;
  if (!lengthKm) {
    for (let i = 1; i < points.length; i++) lengthKm += haversineKm(points[i - 1]!, points[i]!);
  }

  const wayTags = new Set<string>();
  const messages = feature.properties?.messages ?? [];
  const tagLimit = Math.min(messages.length, 120);
  for (let i = 1; i < tagLimit; i++) {
    for (const tag of parseWayTags(messages[i]?.[9])) wayTags.add(tag);
  }

  return finalizeBrouterResult({ points, lengthKm, wayTags: [...wayTags] });
}

async function brouterOnce(waypoints: LngLat[]): Promise<BrouterResult | null> {
  if (waypoints.length < 2) return null;
  const span = routeSpanKm(waypoints);
  const lonlats = waypoints.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join('|');
  const url =
    `${BROUTER_URL}?format=geojson&profile=river&alternativeidx=0&lonlats=` +
    encodeURIComponent(lonlats);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), brouterTimeoutMs(span));
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    return parseBrouterPayload(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Short/medium request with retries. Long spans: only 1 attempt — fail fast, then bisect.
 */
export async function routeWithBrouter(waypoints: LngLat[]): Promise<BrouterResult | null> {
  if (waypoints.length < 2) return null;
  const span = routeSpanKm(waypoints);
  // Corridor oneshots (A+vias+B) often succeed on retry after a watchdog kill.
  const attempts = waypoints.length >= 3 ? 2 : span >= LONG_SPAN_KM ? 1 : 3;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(400 * i);
    const hit = await brouterOnce(waypoints);
    if (hit && hit.points.length >= 2 && hit.lengthKm > 0) return hit;
  }
  return null;
}

function interpolate(a: LngLat, b: LngLat, t: number): LngLat {
  return { lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t };
}

function stitchResults(parts: BrouterResult[]): BrouterResult {
  const points: LngLat[] = [];
  let lengthKm = 0;
  const wayTags = new Set<string>();
  for (const part of parts) {
    if (points.length === 0) points.push(...part.points);
    else points.push(...part.points.slice(1));
    lengthKm += part.lengthKm;
    for (const t of part.wayTags) wayTags.add(t);
  }
  return finalizeBrouterResult({ points, lengthKm, wayTags: [...wayTags] });
}

function looksLikeVolgaBaltic(points: LngLat[]): boolean {
  let hasOnegaBand = false;
  let hasSheksnaBand = false;
  for (const p of points) {
    if (p.lat >= 60.6 && p.lon >= 34.0 && p.lon <= 37.5) hasOnegaBand = true;
    if (p.lat >= 58.9 && p.lat <= 60.2 && p.lon >= 37.5 && p.lon <= 38.8) hasSheksnaBand = true;
  }
  return hasOnegaBand && hasSheksnaBand;
}

/** Paths that climbed to Селижаровка / upper Volga when the corridor is Волго-Балт. */
function looksLikeUpperVolgaTrap(points: LngLat[], a: LngLat, b: LngLat): boolean {
  // Legitimate when an endpoint is actually on the upper Volga / Селигер.
  if (nearUpperVolga(a) || nearUpperVolga(b)) return false;
  for (const p of points) {
    if (p.lon <= 35.5 && p.lat >= 56.6 && p.lat <= 57.3) return true;
  }
  return false;
}

function firstIndexInBox(
  points: LngLat[],
  box: { lonMin: number; lonMax: number; latMin: number; latMax: number },
): number {
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (
      p.lon >= box.lonMin &&
      p.lon <= box.lonMax &&
      p.lat >= box.latMin &&
      p.lat <= box.latMax
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Куйбышев→west must not touch Moscow Canal before Горьковское
 * (sign of Oka/Москва cutoff or reversed canal vias).
 */
function looksLikeCanalBeforeCascade(points: LngLat[], a: LngLat, b: LngLat): boolean {
  if (nearMoscow(a) || nearMoscow(b)) return false;
  const canal = firstIndexInBox(points, {
    lonMin: 37.05,
    lonMax: 37.7,
    latMin: 55.82,
    latMax: 56.75,
  });
  const gorky = firstIndexInBox(points, {
    lonMin: 42.2,
    lonMax: 43.7,
    latMin: 56.35,
    latMax: 57.55,
  });
  if (canal < 0 || gorky < 0 || canal >= gorky) return false;
  const east = Math.max(a.lon, b.lon);
  const west = Math.min(a.lon, b.lon);
  return east >= 45 && west <= 40;
}

/**
 * Geodesic midpoints often snap Куйбышев→Москва onto Ока.
 * Box stays south of the Volga fairway near НН (~56.2+).
 */
function looksLikeOkaMoskvaCutoff(points: LngLat[], a: LngLat, b: LngLat): boolean {
  if (!inVolgaBasin(a) || !inVolgaBasin(b)) return false;
  if (nearMoscow(a) || nearMoscow(b)) {
    const other = nearMoscow(a) ? b : a;
    if (other.lon < 45) return false;
  }
  let okaKm = 0;
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    if (p.lon >= 36.8 && p.lon <= 43.2 && p.lat >= 54.5 && p.lat <= 55.95) {
      okaKm += haversineKm(points[i - 1]!, p);
    }
  }
  return okaKm > 280;
}

/** East→west Volga hop that never touches Горький/Чебоксары — usually an air/Oka cut. */
function looksLikeMissingCascade(points: LngLat[], a: LngLat, b: LngLat): boolean {
  const east = Math.max(a.lon, b.lon);
  const west = Math.min(a.lon, b.lon);
  if (east < 46 || west > 40) return false;
  if (haversineKm(a, b) < 400) return false;
  const gorky = firstIndexInBox(points, {
    lonMin: 42.2,
    lonMax: 43.7,
    latMin: 56.35,
    latMax: 57.55,
  });
  const cheb = firstIndexInBox(points, {
    lonMin: 45.4,
    lonMax: 48.5,
    latMin: 55.7,
    latMax: 56.65,
  });
  return gorky < 0 && cheb < 0;
}

/** Going to Рыбинск from the east via Углич (wrong branch). */
function looksLikeUglichBeforeRybinsk(points: LngLat[], a: LngLat, b: LngLat): boolean {
  if (Math.max(a.lon, b.lon) < 44) return false;
  const dest = a.lon <= b.lon ? a : b;
  // Destination should be in/near Rybinsk, not primarily Uglich.
  const nearRb = dest.lat >= 57.75 && dest.lon >= 37.55 && dest.lon <= 39.3;
  if (!nearRb) return false;
  const ug = firstIndexInBox(points, {
    lonMin: 37.55,
    lonMax: 38.45,
    latMin: 56.88,
    latMax: 57.68,
  });
  const rb = firstIndexInBox(points, {
    lonMin: 37.55,
    lonMax: 39.25,
    latMin: 57.75,
    latMax: 59.1,
  });
  return ug >= 0 && rb >= 0 && ug < rb;
}

/**
 * Черёмуха — правый приток в центре Рыбинска. Городец→Талица / Волга must
 * stay on the lock/fairway, not climb the Cheremukha.
 */
function onCheremukhaBasin(p: LngLat): boolean {
  return p.lon >= 38.78 && p.lon <= 39.0 && p.lat >= 57.85 && p.lat <= 58.035;
}

function looksLikeCheremukhaDetour(points: LngLat[], a: LngLat, b: LngLat): boolean {
  if (onCheremukhaBasin(a) || onCheremukhaBasin(b)) return false;
  let km = 0;
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    // Tight box: Cheremukha channel south of the Volga stem in Rybinsk.
    if (p.lon >= 38.82 && p.lon <= 38.95 && p.lat >= 57.92 && p.lat <= 58.035) {
      km += haversineKm(points[i - 1]!, p);
    }
  }
  return km > 3;
}

/**
 * Any hit on Москва-река when neither endpoint is near Moscow means the
 * router left the Volga cascade (Ока cutoff / air chord densified wrong).
 * Do NOT require endpoints to straddle lon 40 — Куйбышев↔Чебоксары are both east.
 */
function looksLikeMoskvaDetour(points: LngLat[], a: LngLat, b: LngLat): boolean {
  if (nearMoscow(a) || nearMoscow(b)) return false;
  const moskva = firstIndexInBox(points, {
    lonMin: 35.8,
    lonMax: 38.0,
    latMin: 55.55,
    latMax: 55.95,
  });
  return moskva >= 0;
}

/**
 * СПб/Волго-Балт ↔ Кама/Белая must not drop south to Дубна / Канал им. Москвы.
 * That was the stem-fallback trap (nearest pin = Селижарово/Дубна).
 */
function looksLikeDubnaTrapOnBaltic(points: LngLat[], a: LngLat, b: LngLat): boolean {
  if (nearMoscow(a) || nearMoscow(b) || nearUpperVolga(a) || nearUpperVolga(b)) return false;
  if (!nearNorthwestWaterway(a) && !nearNorthwestWaterway(b)) return false;
  if (!isVolgaBalticLongCorridor(a, b) && !nearKamaBelaya(a) && !nearKamaBelaya(b)) {
    return false;
  }
  const dubna = firstIndexInBox(points, {
    lonMin: 36.85,
    lonMax: 37.55,
    latMin: 56.55,
    latMax: 56.95,
  });
  const canal = firstIndexInBox(points, {
    lonMin: 37.05,
    lonMax: 37.75,
    latMin: 55.82,
    latMax: 56.55,
  });
  return dubna >= 0 || canal >= 0;
}

/** Path length wildly longer than the geodesic — loop / wrong basin. */
function looksLikeExcessDetour(
  points: LngLat[],
  a: LngLat,
  b: LngLat,
  lengthKm?: number,
): boolean {
  const geo = haversineKm(a, b);
  if (geo < 40) return false;
  const len = lengthKm ?? pathLengthKm(points);
  // Hard basin hops (Ока/Москва) stay strict; clean cascade winding can be ~2–3×.
  const hardHop =
    looksLikeMoskvaDetour(points, a, b) ||
    looksLikeOkaMoskvaCutoff(points, a, b) ||
    looksLikeCanalBeforeCascade(points, a, b);
  const limit = hardHop ? 2.2 : 3.5;
  return len > geo * limit;
}

/**
 * Collapsed BRouter snap (track much shorter than A→B) or a true land/air chord.
 */
function looksLikeNearGeodesicLandCut(
  points: LngLat[],
  a: LngLat,
  b: LngLat,
  lengthKm?: number,
): boolean {
  const geo = haversineKm(a, b);
  if (geo < 12) return false;
  const len = lengthKm ?? pathLengthKm(points);
  const ratio = len / Math.max(geo, 0.001);

  // BRouter snapped both ends to the same neighborhood — not a real span.
  if (len < geo * 0.85) return true;
  if (points.length <= 2 && geo >= 8) return true;

  // True air/land chord only — real fairways are often 1.15–1.4×.
  if (ratio <= 1.04) return true;
  if (ratio <= 1.1 && points.length < Math.max(5, geo / 25)) return true;
  return false;
}

/** Basin-hopping / wrong-branch — always reject. */
function isHardBadVolgaPath(points: LngLat[], a: LngLat, b: LngLat): boolean {
  return (
    looksLikeCanalBeforeCascade(points, a, b) ||
    looksLikeOkaMoskvaCutoff(points, a, b) ||
    looksLikeUpperVolgaTrap(points, a, b) ||
    looksLikeMissingCascade(points, a, b) ||
    looksLikeUglichBeforeRybinsk(points, a, b) ||
    looksLikeMoskvaDetour(points, a, b) ||
    looksLikeCheremukhaDetour(points, a, b) ||
    looksLikeDubnaTrapOnBaltic(points, a, b) ||
    looksLikeSkippingDubnaLock(points)
  );
}

function isSuspiciousVolgaPath(
  points: LngLat[],
  a: LngLat,
  b: LngLat,
  lengthKm?: number,
): boolean {
  return (
    isHardBadVolgaPath(points, a, b) ||
    looksLikeExcessDetour(points, a, b, lengthKm) ||
    looksLikeNearGeodesicLandCut(points, a, b, lengthKm)
  );
}

function nearestOnFairway(p: LngLat, fairway: LngLat[]): { idx: number; dist: number } {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < fairway.length; i++) {
    const d = haversineKm(p, fairway[i]!);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return { idx: best, dist: bestD };
}

function fairwaySlice(fairway: LngLat[], ia: number, ib: number): LngLat[] {
  if (ia === ib) return [];
  const lo = Math.min(ia, ib);
  const hi = Math.max(ia, ib);
  let slice = fairway.slice(lo, hi + 1);
  if (ia > ib) slice = slice.slice().reverse();
  return slice;
}

function thinVias(vias: LngLat[], maxN: number): LngLat[] {
  if (vias.length <= maxN) return vias;
  const critical = (v: LngLat) =>
    haversineKm(v, DUBNA_LOCK) < 1.5 || haversineKm(v, RYBINSK_LOCK) < 1.5;
  const keep = new Set<number>();
  for (let i = 0; i < maxN; i++) {
    keep.add(Math.round((i * (vias.length - 1)) / (maxN - 1)));
  }
  // Never drop шлюз vias — thinning otherwise lets BRouter chord the dam.
  for (let i = 0; i < vias.length; i++) {
    if (critical(vias[i]!)) keep.add(i);
  }
  const out: LngLat[] = [];
  for (const idx of [...keep].sort((a, b) => a - b)) {
    const v = vias[idx]!;
    const last = out[out.length - 1];
    if (!last || last.lon !== v.lon || last.lat !== v.lat) out.push(v);
  }
  return out;
}

function densifyFairway(slice: LngLat[], stepKm: number): LngLat[] {
  if (slice.length < 2) return slice.slice();
  const out: LngLat[] = [slice[0]!];
  for (let i = 1; i < slice.length; i++) {
    const a = slice[i - 1]!;
    const b = slice[i]!;
    const d = haversineKm(a, b);
    const n = Math.max(0, Math.floor(d / stepKm) - 1);
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1);
      out.push({ lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t });
    }
    out.push(b);
  }
  return out;
}

function syntheticFairwayRoute(a: LngLat, b: LngLat, slice: LngLat[]): BrouterResult {
  const dense = densifyFairway(slice, 4);
  const points: LngLat[] = [a];
  for (const p of dense) {
    const last = points[points.length - 1]!;
    if (haversineKm(last, p) >= 0.4) points.push(p);
  }
  const last = points[points.length - 1]!;
  if (haversineKm(last, b) >= 0.4) points.push(b);
  else points[points.length - 1] = b;
  return { points, lengthKm: pathLengthKm(points), wayTags: [] };
}

/**
 * Snap onto a known navigable fairway after collapsed BRouter (open lakes etc.).
 * If BRouter still fails on pins, use densified fairway geometry (lakes/channels).
 */
async function routeViaRegionalFairway(a: LngLat, b: LngLat): Promise<BrouterResult | null> {
  const userGeo = haversineKm(a, b);
  if (userGeo < 8) return null;

  for (const fairway of REGIONAL_FAIRWAYS) {
    let sa = nearestOnFairway(a, fairway);
    let sb = nearestOnFairway(b, fairway);
    const maxSnap = fairway === TOPO_PYAOZERO_FAIRWAY ? 55 : 100;
    if (sa.dist > maxSnap || sb.dist > maxSnap) continue;

    if (sa.idx === sb.idx) {
      if (userGeo < 10) continue;
      // Nudge along chain toward the other endpoint.
      const ia = sa.idx;
      const toward =
        haversineKm(fairway[Math.min(ia + 1, fairway.length - 1)]!, b) <=
        haversineKm(fairway[Math.max(ia - 1, 0)]!, b)
          ? 1
          : -1;
      const next = Math.max(0, Math.min(fairway.length - 1, ia + toward));
      if (next === ia) continue;
      sb = { idx: next, dist: haversineKm(b, fairway[next]!) };
    }

    const slice = fairwaySlice(fairway, sa.idx, sb.idx);
    if (slice.length < 2) continue;

    const pinA = slice[0]!;
    const pinB = slice[slice.length - 1]!;
    const thin = thinVias(slice, 8);

    const acceptPinRoute = (route: BrouterResult | null): BrouterResult | null => {
      if (!route || route.points.length < 2 || route.lengthKm <= 0) return null;
      if (fairway === VOLGA_NAV_FAIRWAY) {
        const fixed = repairDubnaLockPassage(route.points);
        if (fixed !== route.points) {
          route = {
            points: fixed,
            lengthKm: pathLengthKm(fixed),
            wayTags: route.wayTags,
          };
        }
        if (isHardBadVolgaPath(route.points, a, b)) return null;
      }
      const pinGeo = haversineKm(pinA, pinB);
      if (pinGeo >= 8 && route.lengthKm < pinGeo * 0.85) return null;
      if (userGeo >= 15 && route.lengthKm > userGeo * 3.5) return null;
      // Pin-only BRouter often stops at the channel while the user clicked
      // open lake water (Топозеро/Пяозеро) — require ends near the request.
      const d0 = haversineKm(route.points[0]!, a);
      const d1 = haversineKm(route.points[route.points.length - 1]!, b);
      if (d0 > 18 || d1 > 18) return null;
      return route;
    };

    const attempts: LngLat[][] = [
      thin,
      [a, ...thin.filter((v) => haversineKm(a, v) >= 4 && haversineKm(b, v) >= 4), b],
      [a, ...thinVias(thin, 4), b],
    ];

    let found: BrouterResult | null = null;
    for (const pts of attempts) {
      if (pts.length < 2) continue;
      found = acceptPinRoute(await routeWithBrouter(pts));
      if (found) break;
    }

    // Open lakes: BRouter has no centerline — densified fairway is the water path.
    if (!found) {
      const synth = syntheticFairwayRoute(a, b, slice);
      if (synth.lengthKm >= userGeo * 0.7 && synth.lengthKm <= userGeo * 3.5) {
        found = synth;
      }
    }

    if (found) return found;
  }
  return null;
}

/** Volga-specific aliases used by stem corridor vias. */
function nearestFairwayIndex(p: LngLat): { idx: number; dist: number } {
  return nearestOnFairway(p, VOLGA_NAV_FAIRWAY);
}

function fairwaySliceBetween(ia: number, ib: number): LngLat[] {
  return fairwaySlice(VOLGA_NAV_FAIRWAY, ia, ib);
}

/**
 * Route A→…vias…→B.
 * Prefer one multi-via BRouter request (fast, stable on Volga). Fall back to
 * per-via legs if the oneshot is killed — never abandon the corridor.
 */
async function routeAlongVias(
  a: LngLat,
  b: LngLat,
  vias: LngLat[],
  depth: number,
): Promise<BrouterResult | null> {
  const attempts = [thinVias(vias, 5), thinVias(vias, 8)];
  const seen = new Set<string>();
  for (const trimmed of attempts) {
    const key = trimmed.map((v) => `${v.lon.toFixed(2)},${v.lat.toFixed(2)}`).join('|');
    if (!trimmed.length || seen.has(key)) continue;
    seen.add(key);
    const oneshot = await routeWithBrouter([a, ...trimmed, b]);
    if (oneshot && oneshot.points.length >= 2 && oneshot.lengthKm > 0) {
      const ok =
        depth > 0 ||
        !(inVolgaBasin(a) && inVolgaBasin(b)) ||
        !isSuspiciousVolgaPath(oneshot.points, a, b, oneshot.lengthKm);
      if (ok) return oneshot;
    }
  }

  const targets = [...vias, b];
  const parts: BrouterResult[] = [];
  let from = a;
  for (let i = 0; i < targets.length; i++) {
    const to = targets[i]!;
    const isLast = i === targets.length - 1;
    const leg = await routePairAdaptive(from, to, depth + 1);
    if (leg) {
      parts.push(leg);
      from = to;
      continue;
    }
    if (isLast) return null;
  }
  if (from.lon !== b.lon || from.lat !== b.lat) {
    const tail = await routePairAdaptive(from, b, depth + 1);
    if (!tail) return null;
    parts.push(tail);
  }
  if (!parts.length) return null;
  const stitched = stitchResults(parts);
  if (
    depth === 0 &&
    inVolgaBasin(a) &&
    inVolgaBasin(b) &&
    isSuspiciousVolgaPath(stitched.points, a, b, stitched.lengthKm)
  ) {
    return null;
  }
  return stitched;
}

/**
 * Try A→B; on failure recover via fairway snaps / corridor vias.
 * Never geodesic-mid bisect on pinned Volga corridors (Ока/Москва trap).
 */
async function routePairAdaptive(a: LngLat, b: LngLat, depth: number): Promise<BrouterResult | null> {
  const span = haversineKm(a, b);
  const balticCorridor = isVolgaBalticLongCorridor(a, b);
  const stemCorridor = isVolgaStemCorridor(a, b);
  const moscowSpb = isMoscowSpbCorridor(a, b);
  const pinnedCorridor = balticCorridor || stemCorridor || moscowSpb;

  const accept = (route: BrouterResult | null): BrouterResult | null => {
    if (!route) return null;
    // Force Dubna through шлюз №1 whenever the track crosses Иваньково.
    if (inVolgaBasin(a) && inVolgaBasin(b)) {
      const fixed = repairDubnaLockPassage(route.points);
      if (fixed !== route.points) {
        route = {
          points: fixed,
          lengthKm: pathLengthKm(fixed),
          wayTags: route.wayTags,
        };
      }
    }
    if (depth === 0 && moscowSpb && !looksLikeVolgaBaltic(route.points)) {
      return null;
    }
    // СПб ↔ Кама/Белая: must use Волго-Балт, never Дубна/Москва.
    if (depth === 0 && balticCorridor && isHardBadVolgaPath(route.points, a, b)) {
      return null;
    }
    if (
      depth === 0 &&
      balticCorridor &&
      span >= 500 &&
      (nearNorthwestWaterway(a) || nearNorthwestWaterway(b)) &&
      !looksLikeVolgaBaltic(route.points)
    ) {
      return null;
    }
    // Volga-specific heuristics only inside the basin — near-geo/excess must not
    // kill Rhine/Don/Ladoga (or any non-Volga) fairway that happens to be straight.
    if (
      depth === 0 &&
      inVolgaBasin(a) &&
      inVolgaBasin(b) &&
      isSuspiciousVolgaPath(route.points, a, b, route.lengthKm)
    ) {
      return null;
    }
    // Universal: collapsed BRouter snap (track << geodesic) or ends far from A/B.
    if (depth === 0) {
      const geo = haversineKm(a, b);
      if (geo >= 12 && route.lengthKm < geo * 0.85) return null;
      if (geo >= 8 && route.points.length <= 2) return null;
      const d0 = haversineKm(route.points[0]!, a);
      const d1 = haversineKm(route.points[route.points.length - 1]!, b);
      if (geo >= 25 && (d0 > 15 || d1 > 15)) return null;
    }
    return route;
  };

  // Moscow↔SPb / Volga–Baltic: corridor vias first (direct skips Онега/Шексна).
  if (depth === 0 && (balticCorridor || moscowSpb)) {
    const vias = corridorViasBetween(a, b);
    if (vias.length) {
      const viaRoute = accept(await routeAlongVias(a, b, vias, depth));
      if (viaRoute) return viaRoute;
    }
  }

  // Stem / general: direct first — forced mid-vias often collapse or loop.
  if (depth === 0 && !moscowSpb && !balticCorridor) {
    const directFirst = accept(await routeWithBrouter([a, b]));
    if (directFirst) return directFirst;
    const fairwayFirst = await routeViaRegionalFairway(a, b);
    if (fairwayFirst) return fairwayFirst;
  }

  // Corridor vias after direct/fairway failed.
  if (depth === 0) {
    const vias = corridorViasBetween(a, b);
    if (vias.length) {
      const viaRoute = accept(await routeAlongVias(a, b, vias, depth));
      if (viaRoute) return viaRoute;
    }
  }

  const hit = accept(await routeWithBrouter([a, b]));
  if (hit) return hit;

  // Fairway snap recovery for any Volga-basin hop (incl. short span < 50).
  if (depth === 0) {
    const fairway = await routeViaRegionalFairway(a, b);
    if (fairway) return fairway;
  }

  if (depth >= MAX_SPLIT_DEPTH || span < 35) {
    return null;
  }

  const vias = corridorViasBetween(a, b);
  if (pinnedCorridor && vias.length >= 2) {
    const mid = vias[Math.floor(vias.length / 2)]!;
    const left = await routePairAdaptive(a, mid, depth + 1);
    if (left) {
      const right = await routePairAdaptive(mid, b, depth + 1);
      if (right) {
        const stitched = accept(stitchResults([left, right]));
        if (stitched) return stitched;
      }
    }
  }

  // Bisect on dense fairway pins when stem corridor.
  if (depth === 0 && stemCorridor) {
    const sa = nearestFairwayIndex(a);
    const sb = nearestFairwayIndex(b);
    if (sa.dist <= 100 && sb.dist <= 100 && Math.abs(sa.idx - sb.idx) >= 2) {
      const slice = fairwaySliceBetween(sa.idx, sb.idx);
      const mid = slice[Math.floor(slice.length / 2)];
      if (mid) {
        const left = await routePairAdaptive(a, mid, depth + 1);
        if (left) {
          const right = await routePairAdaptive(mid, b, depth + 1);
          if (right) {
            const stitched = accept(stitchResults([left, right]));
            if (stitched) return stitched;
          }
        }
      }
    }
  }

  if (!pinnedCorridor) {
    const mid = interpolate(a, b, 0.5);
    const left = await routePairAdaptive(a, mid, depth + 1);
    if (!left) return null;
    const right = await routePairAdaptive(mid, b, depth + 1);
    if (!right) return null;
    return accept(stitchResults([left, right]));
  }

  return null;
}

/** Reliable river routing for lakes and long inland corridors (Seliger→Vokhma). */
export async function routeWithBrouterAdaptive(
  waypoints: LngLat[],
): Promise<BrouterResult | null> {
  if (waypoints.length < 2) return null;

  if (waypoints.length === 2) {
    return routePairAdaptive(waypoints[0]!, waypoints[1]!, 0);
  }

  const parts: BrouterResult[] = [];
  for (let i = 1; i < waypoints.length; i++) {
    const leg = await routePairAdaptive(waypoints[i - 1]!, waypoints[i]!, 0);
    if (!leg) return null;
    parts.push(leg);
  }
  return stitchResults(parts);
}

export async function routeWithBrouterChunked(
  waypoints: LngLat[],
): Promise<BrouterResult | null> {
  return routeWithBrouterAdaptive(waypoints);
}
