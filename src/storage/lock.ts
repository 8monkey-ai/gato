/** Runs tasks with the same key one after another, in call order. */
export function keyedLock() {
  const tails = new Map<string, Promise<unknown>>();
  return async function locked<T>(
    key: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const result = (tails.get(key) ?? Promise.resolve()).then(task);
    const tail = result.catch(() => undefined);
    tails.set(key, tail);
    try {
      return await result;
    } finally {
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}
