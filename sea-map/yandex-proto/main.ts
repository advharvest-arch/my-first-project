/**
 * Isolated Yandex Maps JS API v3 smoke prototype.
 * Does not import AquaRoute / Leaflet / WaterGraph / PostGIS routing.
 */

declare global {
  // Official browser global from https://api-maps.yandex.ru/v3/
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  var ymaps3: any;
}

/** Southern Belomor sample (lon, lat) — fixed test geometry only. */
const TEST_LINE: Array<[number, number]> = [
  [34.8388123, 62.8358099],
  [34.8392896, 62.8385734],
  [34.8405882, 62.8456079],
  [34.841094, 62.8483784],
  [34.8432565, 62.8569953],
  [34.8441325, 62.8597075],
  [34.8469756, 62.8653724],
];

const START = TEST_LINE[0]!;
const END = TEST_LINE[TEST_LINE.length - 1]!;

const statusEl = document.querySelector<HTMLElement>('#status')!;
const routeBtn = document.querySelector<HTMLButtonElement>('#route-btn')!;
const missingKeyEl = document.querySelector<HTMLElement>('#missing-key')!;

function setStatus(text: string, kind: 'ok' | 'warn' | 'err' = 'warn'): void {
  statusEl.textContent = text;
  statusEl.className = kind;
}

function apiKey(): string {
  const raw = import.meta.env.VITE_YANDEX_MAPS_API_KEY;
  return typeof raw === 'string' ? raw.trim() : '';
}

function loadYmaps3(key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-ymaps3]');
    if (existing && window.ymaps3) {
      void window.ymaps3.ready.then(() => resolve()).catch(reject);
      return;
    }
    const script = document.createElement('script');
    script.src = `https://api-maps.yandex.ru/v3/?apikey=${encodeURIComponent(key)}&lang=ru_RU`;
    script.async = true;
    script.dataset.ymaps3 = '1';
    script.onload = () => {
      void window.ymaps3.ready.then(() => resolve()).catch(reject);
    };
    script.onerror = () => reject(new Error('Failed to load api-maps.yandex.ru/v3'));
    document.head.appendChild(script);
  });
}

function midpoint(a: [number, number], b: [number, number]): [number, number] {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

async function main(): Promise<void> {
  const key = apiKey();
  if (!key) {
    missingKeyEl.classList.add('visible');
    setStatus(
      'Нет VITE_YANDEX_MAPS_API_KEY — карта не загружена (ключ не коммитится).',
      'warn',
    );
    routeBtn.disabled = true;
    return;
  }

  missingKeyEl.classList.remove('visible');
  setStatus('Загрузка Yandex Maps JS API v3…', 'warn');

  try {
    await loadYmaps3(key);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStatus(`Ошибка загрузки API: ${msg}`, 'err');
    return;
  }

  const {
    YMap,
    YMapDefaultSchemeLayer,
    YMapDefaultFeaturesLayer,
    YMapFeature,
    YMapMarker,
  } = window.ymaps3;

  const mapEl = document.getElementById('map');
  if (!mapEl) {
    setStatus('Контейнер #map не найден', 'err');
    return;
  }

  const center = midpoint(START, END);
  const map = new YMap(mapEl, {
    location: { center, zoom: 12 },
    showScaleInCopyrights: true,
  });

  map.addChild(new YMapDefaultSchemeLayer({}));
  map.addChild(new YMapDefaultFeaturesLayer({}));

  const line = new YMapFeature({
    id: 'test-water-line',
    geometry: {
      type: 'LineString',
      coordinates: TEST_LINE,
    },
    style: {
      stroke: [{ width: 5, color: '#0284c7' }],
    },
  });
  map.addChild(line);

  const startMarker = makePointMarker(YMapMarker, START, 'A', '#16a34a');
  const endMarker = makePointMarker(YMapMarker, END, 'B', '#dc2626');
  map.addChild(startMarker);
  map.addChild(endMarker);

  routeBtn.disabled = false;
  routeBtn.addEventListener('click', () => {
    setStatus(
      `«Водный маршрут»: линия ${TEST_LINE.length} точек, A=${START.join(',')}, B=${END.join(',')} (без routing).`,
      'ok',
    );
  });

  setStatus(
    `OK: карта v3, LineString (${TEST_LINE.length} вершин), точки A/B, кнопка активна.`,
    'ok',
  );
}

function makePointMarker(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  YMapMarker: any,
  coordinates: [number, number],
  label: string,
  color: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const el = document.createElement('div');
  el.textContent = label;
  el.style.cssText = [
    'width:28px',
    'height:28px',
    'border-radius:50%',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'font:700 13px/1 sans-serif',
    'color:#fff',
    `background:${color}`,
    'border:2px solid #fff',
    'box-shadow:0 2px 8px rgb(0 0 0 / 35%)',
    'transform:translate(-50%,-50%)',
    'user-select:none',
  ].join(';');

  return new YMapMarker({ coordinates }, el);
}

void main();
