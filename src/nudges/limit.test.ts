import { expect, test } from "bun:test";

import { createLimit } from "./limit.ts";

test("no more than the limit of tasks run at once and every task runs", async () => {
  const limit = createLimit(2);
  let running = 0;
  let most = 0;
  const releases: (() => void)[] = [];
  const task = (n: number) =>
    limit(async () => {
      running++;
      most = Math.max(most, running);
      await new Promise<void>((resolve) => releases.push(resolve));
      running--;
      return n;
    });
  const all = Promise.all([1, 2, 3, 4, 5].map(task));
  while (releases.length > 0 || running > 0) {
    await Promise.resolve();
    releases.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(await all).toEqual([1, 2, 3, 4, 5]);
  expect(most).toBe(2);
});
