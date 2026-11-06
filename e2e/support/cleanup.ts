import { afterEach } from "bun:test";

const cleanups: (() => unknown)[] = [];

// Loaded as a test preload, so the hook applies to every test file.
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export function onCleanup(cleanup: () => unknown) {
  cleanups.push(cleanup);
}
