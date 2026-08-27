/**
 * E1.7 — capped concurrency helper for experimental parallel candidate trials.
 * Default production path stays sequential (USE_PARALLEL_CANDIDATES=false).
 */

export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.min(concurrency, 3));
  const out: R[] = new Array(items.length);
  let next = 0;

  async function run(): Promise<void> {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await worker(items[i]!, i);
    }
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, () => run());
  await Promise.all(runners);
  return out;
}
