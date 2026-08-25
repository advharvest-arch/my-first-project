/**
 * Manual smoke routes against live brouter.de (not part of CI).
 * Run: npx tsx scripts/manual-routes.ts
 */
import { pathLengthKm, type LngLat } from '../src/geo';
import { routeWithBrouterAdaptive } from '../src/brouter';
import { validateWaterRoute } from '../src/validate-water-route';
import {
  DUBNA_LOCK_CORRIDOR,
  crossesDubnaBarrier,
  passesDubnaLockProperly,
  repairDubnaLockPassage,
} from '../src/routing-rules';

const routes: Array<{ name: string; a: LngLat; b: LngLat }> = [
  { name: 'Волга NN→Чебоксары', a: { lon: 43.95, lat: 56.33 }, b: { lon: 47.25, lat: 56.15 } },
  {
    name: 'Дубна шлюз №1 (канал→Волга)',
    a: { lon: 37.1031, lat: 56.7372 },
    b: { lon: 37.4682, lat: 56.8998 },
  },
  {
    name: 'Волго-Балт Рыбинск→Череповец',
    a: { lon: 38.72, lat: 58.07 },
    b: { lon: 37.95, lat: 59.1 },
  },
  {
    name: 'Приток/развилка (Волга→устье Ветлуги)',
    a: { lon: 44.0, lat: 56.33 },
    b: { lon: 45.05, lat: 56.15 },
  },
  {
    name: 'Длинный (Городец→Казань)',
    a: { lon: 43.47, lat: 56.65 },
    b: { lon: 49.05, lat: 55.5 },
  },
  {
    name: 'Неводный (суша Москва→Тула) → ожидаем fail',
    a: { lon: 37.62, lat: 55.75 },
    b: { lon: 37.62, lat: 54.2 },
  },
];

async function main() {
  let ok = 0;
  let fail = 0;
  for (const r of routes) {
    const expectFail = r.name.includes('ожидаем fail');
    process.stdout.write(`• ${r.name} … `);
    try {
      const result = await routeWithBrouterAdaptive([r.a, r.b]);
      if (!result || result.points.length < 2) {
        if (expectFail) {
          console.log('OK (route_not_found)');
          ok += 1;
        } else {
          console.log('FAIL (no route)');
          fail += 1;
        }
        continue;
      }
      const v = validateWaterRoute(result.points, {
        waypoints: [r.a, r.b],
        lengthKm: result.lengthKm,
        method: 'waterway',
      });
      if (expectFail) {
        if (!v.ok) {
          console.log(`OK rejected (${v.issues.join(',')})`);
          ok += 1;
        } else {
          console.log('FAIL (accepted land chord)');
          fail += 1;
        }
        continue;
      }
      if (!v.ok) {
        console.log(`FAIL validator: ${v.issues.join(',')}`);
        fail += 1;
        continue;
      }
      console.log(
        `OK ${result.points.length} pts, ${result.lengthKm.toFixed(1)} km (geo ${pathLengthKm([r.a, r.b]).toFixed(1)})`,
      );
      ok += 1;
    } catch (e) {
      console.log(`ERROR ${e}`);
      fail += 1;
    }
  }

  // Dubna regression without network
  const chord = [
    { lon: 37.08, lat: 56.74 },
    { lon: 37.13, lat: 56.7395 },
    { lon: 37.145, lat: 56.74 },
    { lon: 37.22, lat: 56.76 },
  ];
  const fixed = repairDubnaLockPassage(chord);
  const dubnaOk =
    crossesDubnaBarrier(chord) &&
    !passesDubnaLockProperly(chord) &&
    passesDubnaLockProperly(fixed) &&
    passesDubnaLockProperly(DUBNA_LOCK_CORRIDOR);
  console.log(`• Дубна repair (offline) … ${dubnaOk ? 'OK' : 'FAIL'}`);
  if (dubnaOk) ok += 1;
  else fail += 1;

  console.log(`\nDone: ${ok} ok, ${fail} fail`);
  if (fail) process.exit(1);
}

main();
