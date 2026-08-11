// A bounded-concurrency map. The history importer spawns one `claude -p` per
// session; serially that is ~25 s × 40 sessions, so they have to overlap — but
// unbounded they would fork 40 subprocesses at once.
//
// Two deliberate properties, both load-bearing for the importer:
//   - It NEVER rejects. One session whose subprocess times out or returns
//     garbage must not abort the other 39; failures come back as `error` on
//     that item's result, the same fail-open stance as the hooks.
//   - Results come back in INPUT order, not completion order, so provenance
//     (which proposal came from which session) survives the reordering that
//     concurrency introduces.
// Dependency-free (no node:*) — safe for any bundle.

export interface PoolResult<T, R> {
  item: T;
  index: number;
  value?: R;
  error?: unknown;
}

/**
 * Run `fn` over `items` with at most `limit` in flight.
 *
 * `onSettle` fires as each item finishes (in completion order) so callers can
 * draw progress; it is advisory and its own exceptions are swallowed — a
 * broken progress bar must not take the run down with it.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onSettle?: (done: number, total: number, result: PoolResult<T, R>) => void,
): Promise<Array<PoolResult<T, R>>> {
  const total = items.length;
  const results = new Array<PoolResult<T, R>>(total);
  if (total === 0) return results;

  const width = Math.max(1, Math.min(Math.floor(limit) || 1, total));
  let cursor = 0;
  let done = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= total) return;
      const item = items[index];
      let result: PoolResult<T, R>;
      try {
        result = { item, index, value: await fn(item, index) };
      } catch (error) {
        result = { item, index, error };
      }
      results[index] = result;
      done += 1;
      if (onSettle) {
        try {
          onSettle(done, total, result);
        } catch {
          // a progress callback must never fail the run
        }
      }
    }
  }

  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}
