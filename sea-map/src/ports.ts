export type Port = {
  name: string;
  city: string;
  coords: [number, number]; // [lon, lat]
};

export const PORTS: Port[] = [
  { name: 'Rotterdam', city: 'Роттердам', coords: [4.4, 51.9] },
  { name: 'Shanghai', city: 'Шанхай', coords: [121.5, 31.2] },
  { name: 'Singapore', city: 'Сингапур', coords: [103.85, 1.26] },
  { name: 'Los Angeles', city: 'Лос-Анджелес', coords: [-118.26, 33.74] },
  { name: 'New York', city: 'Нью-Йорк', coords: [-74.02, 40.68] },
  { name: 'Santos', city: 'Сантус', coords: [-46.3, -23.95] },
  { name: 'Cape Town', city: 'Кейптаун', coords: [18.43, -33.91] },
  { name: 'Mumbai', city: 'Мумбаи', coords: [72.84, 18.95] },
  { name: 'Yokohama', city: 'Йокогама', coords: [139.65, 35.45] },
  { name: 'Hamburg', city: 'Гамбург', coords: [9.93, 53.54] },
  { name: 'Novorossiysk', city: 'Новороссийск', coords: [37.78, 44.72] },
  { name: 'Vladivostok', city: 'Владивосток', coords: [131.89, 43.11] },
];

export function formatCoords(lon: number, lat: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(2)}°${ns}, ${Math.abs(lon).toFixed(2)}°${ew}`;
}

export function nearestPortName(lon: number, lat: number, maxKm = 80): string | null {
  let best: { name: string; d: number } | null = null;
  for (const p of PORTS) {
    const d = haversineKm(lat, lon, p.coords[1], p.coords[0]);
    if (!best || d < best.d) best = { name: p.city, d };
  }
  return best && best.d <= maxKm ? best.name : null;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
