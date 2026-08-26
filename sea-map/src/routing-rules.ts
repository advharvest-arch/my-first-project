import { haversineKm, type LngLat } from './geo';

/**
 * Geographic routing rules: fairway pins, lock corridors, basin predicates.
 * Algorithmic BRouter orchestration stays in brouter.ts — data & local repairs live here.
 */

/**
 * Upper Volga only (Селигер / исток). Including these on Чебоксары→Онега
 * pulls the track upstream via Селижаровка instead of Волго-Балт.
 */
export const VOLGA_UPPER_VIAS: LngLat[] = [
  { lon: 33.45, lat: 56.85 }, // Селижарово
  { lon: 35.92, lat: 56.86 }, // Тверь
];

/**
 * Navigable Volga chain, west → east (Селижарово → Куйбышев).
 * Vias are sliced from this order so Куйбышев→Иваньково never visits
 * the Moscow Canal before Горьковское.
 */
export const VOLGA_STEM_CHAIN: LngLat[] = [
  { lon: 33.45, lat: 56.85 }, // Селижарово
  { lon: 35.92, lat: 56.86 }, // Тверь
  { lon: 37.1374, lat: 56.7343 }, // Дубна / шлюз №1
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
export const VOLGA_NAV_FAIRWAY: LngLat[] = [
  // Дубна: южный подходной канал → шлюз №1 → нижний бьеф (вода, не хорда через сушу/плотину)
  { lon: 37.1031, lat: 56.7372 },
  { lon: 37.1199, lat: 56.7289 },
  { lon: 37.1374, lat: 56.7343 }, // верхняя голова шлюза №1
  { lon: 37.1417, lat: 56.7361 }, // нижняя голова
  { lon: 37.1564, lat: 56.7419 },
  { lon: 37.1787, lat: 56.7489 },
  { lon: 37.2058, lat: 56.7691 },
  { lon: 37.2207, lat: 56.7844 },
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
export const TOPO_PYAOZERO_FAIRWAY: LngLat[] = [
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

export const REGIONAL_FAIRWAYS: LngLat[][] = [VOLGA_NAV_FAIRWAY, TOPO_PYAOZERO_FAIRWAY];

/**
 * Волго-Балт north of Рыбинск (Шексна → … → Нева).
 */
export const VOLGA_BALTIC_NORTH_VIAS: LngLat[] = [
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
export const MOSCOW_CANAL_VIAS: LngLat[] = [
  { lon: 37.455, lat: 55.91 }, // Химкинское (судовой ход)
  { lon: 37.48, lat: 56.15 }, // Икша
  { lon: 37.51, lat: 56.35 }, // Дмитров
  { lon: 37.1374, lat: 56.7343 }, // Дубна / шлюз №1 (верхняя голова)
];

/**
 * Шлюз №1 (Дубна) — OSM geometry.
 * BRouter's river graph follows «Волга» north of the chamber (across the dam).
 * Ships must use the lock chamber; keep the forced segment short to avoid splice loops.
 */
export const DUBNA_LOCK_UPPER: LngLat = { lon: 37.1374, lat: 56.7343 };
export const DUBNA_LOCK_LOWER: LngLat = { lon: 37.1417, lat: 56.7361 };
export const DUBNA_LOCK: LngLat = DUBNA_LOCK_UPPER;
/** OSM шлюзы №11–12 (Рыбинский гидроузел / Переборы) — chamber midpoint. */
export const RYBINSK_LOCK: LngLat = { lon: 38.7086, lat: 58.0999 };
/** OSM way 117122422 «Шлюз №11». */
export const RYBINSK_LOCK_11: LngLat = { lon: 38.7083, lat: 58.0998 };
/** OSM way 117122424 «Шлюз №12». */
export const RYBINSK_LOCK_12: LngLat = { lon: 38.7088, lat: 58.1004 };

/**
 * Existing VOLGA_NAV_FAIRWAY pins around the hydro — used as BRouter vias only.
 * Not a dense splice corridor (see Dubna DUBNA_LOCK_CORRIDOR); lock-head-only
 * geometry repair would still risk land chords across the dam island.
 */
const RYBINSK_LOCK_VIA_PINS: LngLat[] = [
  { lon: 38.72, lat: 58.07 }, // нижний бьеф / подход
  RYBINSK_LOCK,
  { lon: 38.65, lat: 58.13 }, // водохранилище, подход к шлюзам
];

/** OSM lower approach canal (way 713010877) — passage check pin. */
const RYBINSK_APPROACH_PINS: LngLat[] = [
  { lon: 38.7283, lat: 58.095 }, // нижний подходной канал
  { lon: 38.72, lat: 58.07 },
  { lon: 38.65, lat: 58.13 },
];

/**
 * Forced Dubna fairway on water only (OSM):
 * 121644654 approach canal → 36931172 → chamber 117109715 → 117109713 → Volga 1308453788.
 * Straight chords through the lock heads alone cross the dam island.
 */
export const DUBNA_LOCK_CORRIDOR: LngLat[] = [
  // южный подходной канал (аванпорт → камера)
  { lon: 37.1031, lat: 56.7372 },
  { lon: 37.1077, lat: 56.7322 },
  { lon: 37.1136, lat: 56.7297 },
  { lon: 37.1199, lat: 56.7289 },
  { lon: 37.1240, lat: 56.7293 },
  { lon: 37.1287, lat: 56.7306 },
  { lon: 37.1312, lat: 56.7318 },
  { lon: 37.1332, lat: 56.7326 },
  { lon: 37.1374, lat: 56.7343 }, // верхняя голова
  { lon: 37.1417, lat: 56.7361 }, // нижняя голова
  // нижний подводящий канал → Волга
  { lon: 37.1508, lat: 56.7400 },
  { lon: 37.1564, lat: 56.7419 },
  { lon: 37.1629, lat: 56.7439 },
  { lon: 37.1675, lat: 56.7454 },
  { lon: 37.1745, lat: 56.7476 },
  { lon: 37.1787, lat: 56.7489 },
  { lon: 37.1842, lat: 56.7510 },
  { lon: 37.1903, lat: 56.7543 },
  { lon: 37.1975, lat: 56.7601 },
  { lon: 37.2058, lat: 56.7691 },
];

/** OSM «Волга» centerline that skips the lock (north of the chamber). */
export function onDubnaDamChord(p: LngLat): boolean {
  // False track across the pressure front — north of шлюз №1 chamber (lower head ~56.7361).
  return p.lon >= 37.125 && p.lon <= 37.150 && p.lat >= 56.7368 && p.lat <= 56.743;
}

export function crossesDubnaBarrier(points: LngLat[]): boolean {
  let west = false;
  let east = false;
  for (const p of points) {
    if (p.lat < 56.65 || p.lat > 56.92) continue;
    if (p.lon <= 37.12) west = true;
    if (p.lon >= 37.18) east = true;
  }
  return west && east;
}

function dubnaDamChordKm(points: LngLat[]): number {
  let km = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (onDubnaDamChord(a) || onDubnaDamChord(b)) km += haversineKm(a, b);
  }
  return km;
}

function inDubnaGateBand(p: LngLat): boolean {
  return p.lat >= 56.70 && p.lat <= 56.80 && p.lon >= 37.05 && p.lon <= 37.25;
}

/** Lon backtracks in the Dubna gate band (the “loops” before/after the lock). */
function hasDubnaLonLoops(points: LngLat[], eastbound: boolean): boolean {
  const band = points.filter(inDubnaGateBand);
  for (let i = 1; i < band.length; i++) {
    const dlon = band[i]!.lon - band[i - 1]!.lon;
    if (eastbound && dlon < -0.006) return true;
    if (!eastbound && dlon > 0.006) return true;
  }
  return false;
}

/** Path near southern approach canal (not a land chord to the lock heads). */
function nearDubnaApproachCanal(points: LngLat[]): boolean {
  const canalPins: LngLat[] = [
    { lon: 37.1199, lat: 56.7289 },
    { lon: 37.1287, lat: 56.7306 },
  ];
  return canalPins.some((pin) => points.some((p) => haversineKm(p, pin) <= 0.25));
}

/** True only if the track visits both lock heads via water (not dam / land chords). */
export function passesDubnaLockProperly(points: LngLat[]): boolean {
  const nearUpper = points.some((p) => haversineKm(p, DUBNA_LOCK_UPPER) <= 0.12);
  const nearLower = points.some((p) => haversineKm(p, DUBNA_LOCK_LOWER) <= 0.12);
  if (!nearUpper || !nearLower) return false;
  if (dubnaDamChordKm(points) > 0.15) return false;
  if (!nearDubnaApproachCanal(points)) return false;
  return true;
}

/**
 * Clip the OSM water corridor between the cut endpoints without lon backtracks.
 */
function clipDubnaCorridor(
  corridor: LngLat[],
  from: LngLat,
  to: LngLat,
  eastbound: boolean,
): LngLat[] {
  let c0 = -1;
  let best0 = Infinity;
  for (let i = 0; i < corridor.length; i++) {
    const p = corridor[i]!;
    const behind = eastbound ? p.lon < from.lon - 0.002 : p.lon > from.lon + 0.002;
    if (behind) continue;
    const d = haversineKm(from, p);
    if (d < best0) {
      best0 = d;
      c0 = i;
    }
  }
  if (c0 < 0) {
    c0 = 0;
    best0 = Infinity;
    for (let i = 0; i < corridor.length; i++) {
      const d = haversineKm(from, corridor[i]!);
      if (d < best0) {
        best0 = d;
        c0 = i;
      }
    }
  }

  let c1 = -1;
  let best1 = Infinity;
  for (let i = c0; i < corridor.length; i++) {
    const p = corridor[i]!;
    const ahead = eastbound ? p.lon > to.lon + 0.002 : p.lon < to.lon - 0.002;
    if (ahead) continue;
    const d = haversineKm(to, p);
    if (d < best1) {
      best1 = d;
      c1 = i;
    }
  }
  if (c1 < 0) c1 = corridor.length - 1;

  // Always keep both lock heads.
  for (let i = 0; i < corridor.length; i++) {
    const p = corridor[i]!;
    if (
      haversineKm(p, DUBNA_LOCK_UPPER) <= 0.05 ||
      haversineKm(p, DUBNA_LOCK_LOWER) <= 0.05
    ) {
      c0 = Math.min(c0, i);
      c1 = Math.max(c1, i);
    }
  }

  let slice = corridor.slice(c0, c1 + 1);
  if (slice.length < 2) slice = corridor.slice();

  while (
    slice.length > 2 &&
    haversineKm(from, slice[1]!) + 0.03 < haversineKm(from, slice[0]!)
  ) {
    slice = slice.slice(1);
  }
  while (
    slice.length > 2 &&
    haversineKm(to, slice[slice.length - 2]!) + 0.03 <
      haversineKm(to, slice[slice.length - 1]!)
  ) {
    slice = slice.slice(0, -1);
  }

  // Trimming must not drop the chamber.
  const hasUpper = slice.some((p) => haversineKm(p, DUBNA_LOCK_UPPER) <= 0.05);
  const hasLower = slice.some((p) => haversineKm(p, DUBNA_LOCK_LOWER) <= 0.05);
  if (!hasUpper || !hasLower) return corridor.slice(c0, c1 + 1);
  return slice;
}

/**
 * Replace the Dubna gate band with the OSM water corridor (canal → lock → Volga).
 * Always runs unless the path already follows that water geometry without loops.
 */
export function repairDubnaLockPassage(points: LngLat[]): LngLat[] {
  if (points.length < 2 || !crossesDubnaBarrier(points)) return points;

  // Cut just outside the corridor ends so splices stay on water.
  const WEST = 37.100;
  const EAST = 37.208;
  const inLat = (p: LngLat) => p.lat >= 56.65 && p.lat <= 56.92;

  const band = points
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => inLat(p) && p.lon >= 36.9 && p.lon <= 37.5);
  if (band.length < 2) return points;
  const eastbound = band[band.length - 1]!.p.lon >= band[0]!.p.lon;

  if (
    passesDubnaLockProperly(points) &&
    !hasDubnaLonLoops(points, eastbound)
  ) {
    return points;
  }

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

  // Prefer the cut endpoint nearest the canal mouth / Volga exit (avoid land chords).
  const mouth = eastbound
    ? DUBNA_LOCK_CORRIDOR[0]!
    : DUBNA_LOCK_CORRIDOR[DUBNA_LOCK_CORRIDOR.length - 1]!;
  const exit = eastbound
    ? DUBNA_LOCK_CORRIDOR[DUBNA_LOCK_CORRIDOR.length - 1]!
    : DUBNA_LOCK_CORRIDOR[0]!;

  let bestIn = iIn;
  let bestInD = haversineKm(points[iIn]!, mouth);
  for (let j = iIn; j >= Math.max(0, iIn - 50); j--) {
    const p = points[j]!;
    if (!inLat(p)) continue;
    if (eastbound ? p.lon > WEST : p.lon < EAST) continue;
    if (!inDubnaGateBand(p) && haversineKm(p, mouth) > 3) break;
    const d = haversineKm(p, mouth);
    if (d + 0.05 < bestInD) {
      bestInD = d;
      bestIn = j;
    }
  }
  iIn = bestIn;

  let bestOut = iOut;
  let bestOutD = haversineKm(points[iOut]!, exit);
  for (let j = iOut; j < Math.min(points.length, iOut + 50); j++) {
    const p = points[j]!;
    if (!inLat(p)) continue;
    if (eastbound ? p.lon < EAST : p.lon > WEST) continue;
    if (!inDubnaGateBand(p) && haversineKm(p, exit) > 3) break;
    const d = haversineKm(p, exit);
    if (d + 0.05 < bestOutD) {
      bestOutD = d;
      bestOut = j;
    }
  }
  iOut = bestOut;

  // Trim residual approach/exit lon backtracks just outside the cut.
  if (eastbound) {
    while (
      iIn > 0 &&
      inDubnaGateBand(points[iIn]!) &&
      points[iIn]!.lon < points[iIn - 1]!.lon
    ) {
      iIn -= 1;
    }
    while (
      iOut + 1 < points.length &&
      inDubnaGateBand(points[iOut]!) &&
      points[iOut + 1]!.lon < points[iOut]!.lon
    ) {
      iOut += 1;
    }
  } else {
    while (
      iIn > 0 &&
      inDubnaGateBand(points[iIn]!) &&
      points[iIn]!.lon > points[iIn - 1]!.lon
    ) {
      iIn -= 1;
    }
    while (
      iOut + 1 < points.length &&
      inDubnaGateBand(points[iOut]!) &&
      points[iOut + 1]!.lon > points[iOut]!.lon
    ) {
      iOut += 1;
    }
  }

  const corridor = eastbound
    ? DUBNA_LOCK_CORRIDOR
    : DUBNA_LOCK_CORRIDOR.slice().reverse();
  const slice = clipDubnaCorridor(
    corridor,
    points[iIn]!,
    points[iOut]!,
    eastbound,
  );

  return [...points.slice(0, iIn + 1), ...slice, ...points.slice(iOut)];
}

/**
 * Path crosses Иваньковская плотина without a proper lock №1 passage.
 */
export function looksLikeSkippingDubnaLock(points: LngLat[]): boolean {
  if (!crossesDubnaBarrier(points)) return false;
  return !passesDubnaLockProperly(points);
}

/**
 * False BRouter river track across the Rybinsk HPP / dam body
 * (east of locks №11–12, ~Шекснинское шоссе / Гэсовская промзона).
 * Lock canal at ~38.71 must NOT match this band.
 */
export function onRybinskDamChord(p: LngLat): boolean {
  return p.lon >= 38.78 && p.lon <= 38.86 && p.lat >= 58.085 && p.lat <= 58.108;
}

function rybinskDamChordKm(points: LngLat[]): number {
  let km = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (onRybinskDamChord(a) || onRybinskDamChord(b)) km += haversineKm(a, b);
  }
  return km;
}

function nearRybinskLockChamber(p: LngLat): boolean {
  return (
    haversineKm(p, RYBINSK_LOCK) <= 0.2 ||
    haversineKm(p, RYBINSK_LOCK_11) <= 0.2 ||
    haversineKm(p, RYBINSK_LOCK_12) <= 0.2
  );
}

function nearRybinskApproachCanal(points: LngLat[]): boolean {
  return RYBINSK_APPROACH_PINS.some((pin) =>
    points.some((p) => haversineKm(p, pin) <= 0.35),
  );
}

/**
 * Track straddles Рыбинский гидроузел (lower Volga pool ↔ reservoir / Шексна).
 * Dam-chord alone is enough — BRouter often only samples the crest.
 */
export function crossesRybinskBarrier(points: LngLat[]): boolean {
  if (rybinskDamChordKm(points) > 0.05) return true;
  let south = false;
  let north = false;
  for (const p of points) {
    if (p.lon < 38.55 || p.lon > 38.95) continue;
    if (p.lat >= 57.98 && p.lat <= 58.088) south = true;
    if (p.lat >= 58.105 && p.lat <= 58.35) north = true;
  }
  return south && north;
}

/** True when the track uses locks №11/12 via water (not the HPP crest). */
export function passesRybinskLockProperly(points: LngLat[]): boolean {
  if (!points.some(nearRybinskLockChamber)) return false;
  if (!nearRybinskApproachCanal(points)) return false;
  if (rybinskDamChordKm(points) > 0.15) return false;
  return true;
}

/**
 * Path crosses Рыбинская ГЭС / плотина without a proper lock №11/12 passage.
 */
export function looksLikeSkippingRybinskLock(points: LngLat[]): boolean {
  if (!crossesRybinskBarrier(points)) return false;
  return !passesRybinskLockProperly(points);
}

/**
 * One end in the lower pool at Rybinsk, the other on the reservoir / Шексна /
 * Череповец side — must pin locks №11–12 (not city-pair specific).
 */
export function endpointsStraddleRybinskBarrier(a: LngLat, b: LngLat): boolean {
  const lowerPool = (p: LngLat) =>
    p.lat >= 57.95 && p.lat <= 58.088 && p.lon >= 38.55 && p.lon <= 39.1;
  const upperSide = (p: LngLat) =>
    p.lat >= 58.105 && p.lat <= 59.5 && p.lon >= 37.4 && p.lon <= 38.95;
  return (lowerPool(a) && upperSide(b)) || (lowerPool(b) && upperSide(a));
}

/**
 * BRouter vias through existing fairway lock pins when endpoints straddle the hydro.
 * Prefer via over geometry splice — no dense hardcoded corridor.
 */
export function rybinskLockViasIfNeeded(a: LngLat, b: LngLat): LngLat[] {
  if (!endpointsStraddleRybinskBarrier(a, b)) return [];
  const southToNorth = a.lat <= b.lat;
  return southToNorth
    ? RYBINSK_LOCK_VIA_PINS.slice()
    : RYBINSK_LOCK_VIA_PINS.slice().reverse();
}

/** Кама / Белая (Н. Челны → Уфа → Белорецк) — east of the Volga stem end. */
export const KAMA_BELAYA_VIAS: LngLat[] = [
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
export const VOLGA_BALTIC_VIAS: LngLat[] = [
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


export function nearMoscow(p: LngLat): boolean {
  return p.lat >= 55.4 && p.lat <= 56.35 && p.lon >= 36.9 && p.lon <= 38.1;
}

export function nearSpb(p: LngLat): boolean {
  return p.lat >= 59.55 && p.lat <= 60.25 && p.lon >= 29.4 && p.lon <= 31.2;
}

/** Селигер / верхняя Волга (west of Tver). */
export function nearUpperVolga(p: LngLat): boolean {
  return p.lat >= 56.55 && p.lat <= 57.7 && p.lon >= 32.4 && p.lon <= 36.2;
}

/** Онега / Ладога / Нева / Белозерский участок Волго-Балта. */
export function nearNorthwestWaterway(p: LngLat): boolean {
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
export function inVolgaBasin(p: LngLat): boolean {
  return p.lat >= 52.8 && p.lat <= 59.15 && p.lon >= 32.5 && p.lon <= 52.5;
}

/** Волга below Dubna / mid cascade (incl. Куйбышев south arm). */
export function nearVolgaCascade(p: LngLat): boolean {
  return p.lat >= 52.8 && p.lat <= 59.15 && p.lon >= 37.0 && p.lon <= 52.5;
}

/** Кама basin + Белая up to Белорецк (east of Volga stem). */
export function nearKamaBelaya(p: LngLat): boolean {
  return p.lat >= 52.8 && p.lat <= 60.6 && p.lon >= 48.5 && p.lon <= 59.5;
}

export function isMoscowSpbCorridor(a: LngLat, b: LngLat): boolean {
  return (nearMoscow(a) && nearSpb(b)) || (nearMoscow(b) && nearSpb(a));
}

/**
 * One end on NW waterway (Онега/Ладога/СПб…), the other on Volga cascade /
 * Moscow / Kama–Belaya. Must NOT use Селижарово/Дубна — go Рыбинск → Шексна.
 */
export function isVolgaBalticLongCorridor(a: LngLat, b: LngLat): boolean {
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
export function nearestStemIndex(p: LngLat): number {
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
export function isVolgaStemCorridor(a: LngLat, b: LngLat): boolean {
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


/** Known shipping barriers that must not be crossed as land chords. */
export type KnownBarrier = {
  id: string;
  label: string;
  /** True when the track straddles the barrier. */
  crosses: (points: LngLat[]) => boolean;
  /** True when the track uses a valid water passage (lock / canal). */
  hasValidPassage: (points: LngLat[]) => boolean;
  /** Optional geometry repair that splices the lock corridor. */
  repair?: (points: LngLat[]) => LngLat[];
};

export const KNOWN_BARRIERS: KnownBarrier[] = [
  {
    id: 'dubna-lock-1',
    label: 'Шлюз №1 КиМ (Дубна)',
    crosses: crossesDubnaBarrier,
    hasValidPassage: passesDubnaLockProperly,
    repair: repairDubnaLockPassage,
  },
  {
    // Detect + reject crest crossings; passage via BRouter lock vias
    // (rybinskLockViasIfNeeded). Dense OSM splice corridor not added —
    // same class of hardcode as DUBNA_LOCK_CORRIDOR; prefer via.
    id: 'rybinsk-locks-11-12',
    label: 'Шлюзы №11–12 (Рыбинский гидроузел)',
    crosses: crossesRybinskBarrier,
    hasValidPassage: passesRybinskLockProperly,
  },
];

/** Apply all known barrier repairs (e.g. Dubna lock corridor). */
export function applyKnownBarrierRepairs(points: LngLat[]): LngLat[] {
  let out = points;
  for (const barrier of KNOWN_BARRIERS) {
    if (!barrier.repair) continue;
    if (!barrier.crosses(out)) continue;
    const next = barrier.repair(out);
    if (next !== out) out = next;
  }
  return out;
}

/** True if any known barrier is crossed without a valid water passage. */
export function hasIllegalBarrierCrossing(points: LngLat[]): boolean {
  for (const barrier of KNOWN_BARRIERS) {
    if (barrier.crosses(points) && !barrier.hasValidPassage(points)) return true;
  }
  return false;
}
