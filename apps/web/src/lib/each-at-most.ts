/**
 * Runs `work` on every item, at most `limit` at once, and resolves once all have settled with
 * the ones that failed and why. A bulk action on hundreds of items never opens hundreds of
 * requests at once, and one failure does not stop the rest.
 */
export async function eachAtMost<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<unknown>,
) {
  const failed: { item: T; error: unknown }[] = [];
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      try {
        await work(item);
      } catch (error) {
        failed.push({ item, error });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return failed;
}
