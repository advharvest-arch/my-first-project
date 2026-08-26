/**
 * Offline itinerary post-process tests (no BRouter / network).
 */
import { describe, expect, it } from 'vitest';
import {
  foldSandwichedShortSegments,
  formatItinerary,
  type ItinerarySegment,
} from '../waterways';

const seg = (name: string, km: number): ItinerarySegment => ({ name, km });

describe('foldSandwichedShortSegments', () => {
  it('A: trunk → short non-trunk → same trunk → one trunk', () => {
    const out = foldSandwichedShortSegments([
      seg('Волга', 100),
      seg('Сходня', 0.8),
      seg('Волга', 50),
    ]);
    expect(out).toEqual([seg('Волга', 150.8)]);
  });

  it('B: trunk → short non-trunk → other trunk → keep short (outers differ)', () => {
    const out = foldSandwichedShortSegments([
      seg('Волга', 100),
      seg('Сходня', 0.8),
      seg('Кама', 50),
    ]);
    expect(out.map((s) => s.name)).toEqual(['Волга', 'Сходня', 'Кама']);
    expect(out[1]!.km).toBe(0.8);
  });

  it('C: trunk → notable non-trunk → same trunk → keep non-trunk', () => {
    const out = foldSandwichedShortSegments([
      seg('Волга', 100),
      seg('Сходня', 12),
      seg('Волга', 50),
    ]);
    expect(out.map((s) => s.name)).toEqual(['Волга', 'Сходня', 'Волга']);
    expect(out[1]!.km).toBe(12);
  });

  it('D: trunk → short lake/reservoir → same trunk → keep lake', () => {
    const out = foldSandwichedShortSegments([
      seg('Волга', 100),
      seg('Рыбинское водохранилище', 1.0),
      seg('Волга', 50),
    ]);
    expect(out.map((s) => s.name)).toEqual([
      'Волга',
      'Рыбинское водохранилище',
      'Волга',
    ]);
  });

  it('E: A → short B → A → absorb B', () => {
    const out = foldSandwichedShortSegments([
      seg('Кама', 200),
      seg('Ручей Тестов', 1.2),
      seg('Кама', 180),
    ]);
    expect(out).toEqual([seg('Кама', 381.2)]);
  });

  it('F: A → long B → A → keep B', () => {
    const out = foldSandwichedShortSegments([
      seg('Кама', 200),
      seg('Ручей Тестов', 25),
      seg('Кама', 180),
    ]);
    expect(out.map((s) => s.name)).toEqual(['Кама', 'Ручей Тестов', 'Кама']);
    expect(out[1]!.km).toBe(25);
  });

  it('does not absorb short corridor tributary between same trunk', () => {
    const out = foldSandwichedShortSegments([
      seg('Волга', 40),
      seg('Ветлуга', 1.0),
      seg('Волга', 40),
    ]);
    expect(out.map((s) => s.name)).toEqual(['Волга', 'Ветлуга', 'Волга']);
  });
});

describe('formatItinerary', () => {
  it('G: formats name + km with existing separator style', () => {
    const text = formatItinerary([
      seg('Кама', 285.54),
      seg('Воткинское водохранилище', 17.6),
    ]);
    expect(text).toBe(
      [
        `Кама (${(285.5).toLocaleString('ru-RU', {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        })} км)`,
        `Воткинское водохранилище (${(17.6).toLocaleString('ru-RU', {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        })} км)`,
      ].join(' — '),
    );
  });
});
