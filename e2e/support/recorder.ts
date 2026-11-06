export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

/** Waits until the predicate holds or the time runs out. */
export async function until<T>(
  probe: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > end) throw new Error("condition did not hold in time");
    await Bun.sleep(25);
  }
}

export async function readBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return Object.fromEntries(new URLSearchParams(text));
  }
}
