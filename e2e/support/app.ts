import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function tempDir(prefix = "gato-e2e-") {
  return await mkdtemp(join(tmpdir(), prefix));
}

type Truthy<T> = Exclude<T, false | 0 | "" | null | undefined>;

export async function waitFor<T>(
  check: () => T | Promise<T>,
  timeoutMs = 8000,
  label = "condition",
): Promise<Truthy<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as Truthy<T>;
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(25);
  }
}

export interface RunningApp {
  url: string;
  dataDir: string;
  logs: string[];
  exited: Promise<number>;
  stop(): Promise<number>;
}

function collect(stream: ReadableStream<Uint8Array>, logs: string[]) {
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      logs.push(...lines);
      if (process.env.E2E_VERBOSE) lines.forEach((line) => console.log(line));
    }
  })();
}

export function logEvents(logs: string[], event: string) {
  return logs
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.event === event);
}

export function launch(env: Record<string, string>) {
  const logs: string[] = [];
  const child = Bun.spawn(["bun", "src/main.ts"], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      PORT: "0",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  collect(child.stdout, logs);
  collect(child.stderr, logs);
  return { child, logs };
}

export async function startApp(
  env: Record<string, string>,
): Promise<RunningApp> {
  const dataDir = env.DATA_DIR ?? (await tempDir());
  const { child, logs } = launch({ ...env, DATA_DIR: dataDir });
  const ready = await waitFor(
    () =>
      logs.find((line) => line.includes('"app.ready"')) ??
      (child.exitCode !== null ? "exited" : undefined),
    15000,
    "app ready",
  );
  if (ready === "exited")
    throw new Error(`App exited during startup:\n${logs.join("\n")}`);
  const port = (JSON.parse(ready) as { port: number }).port;
  return {
    url: `http://localhost:${port}`,
    dataDir,
    logs,
    exited: child.exited,
    async stop() {
      child.kill("SIGTERM");
      return await child.exited;
    },
  };
}
