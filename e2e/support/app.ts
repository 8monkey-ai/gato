import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { until } from "./recorder.ts";

const root = join(import.meta.dir, "../..");

export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `gato-${prefix}-`));
}

export async function writeFiles(dir: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

export const defaultSkills = {
  "AGENTS.md":
    "Common rule.\n\n:::my\nMalaysia rule.\n:::\n\n:::ph\nPhilippines rule.\n:::\n",
  "skills/pricing/SKILL.md":
    "---\nname: pricing\ndescription: Prices my[in MYR]ph[in PHP].\n---\nPrice list. my[RM 10]ph[PHP 100]\n",
};

export interface App {
  url: string;
  dataDir: string;
  logs: string[];
  exited: Promise<number>;
  stop(): Promise<number>;
}

/** Starts the harness as a process, the way it runs in production. */
export async function startApp(
  env: Record<string, string>,
  options: { waitReady?: boolean } = {},
): Promise<App> {
  const logs: string[] = [];
  const child = Bun.spawn(["bun", "src/main.ts"], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", PORT: "0", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let rest = "";
    for await (const chunk of stream) {
      const lines = (rest + decoder.decode(chunk, { stream: true })).split(
        "\n",
      );
      rest = lines.pop() ?? "";
      logs.push(...lines.filter(Boolean));
    }
  };
  void collect(child.stdout);
  void collect(child.stderr);
  const app: App = {
    url: "",
    dataDir: env.DATA_DIR ?? "",
    logs,
    exited: child.exited,
    async stop() {
      child.kill("SIGTERM");
      return child.exited;
    },
  };
  if (options.waitReady === false) return app;
  const ready = await until(
    () => logs.find((line) => line.includes('"harness.ready"')),
    15_000,
  ).catch(() => {
    child.kill("SIGKILL");
    throw new Error(`app did not start:\n${logs.join("\n")}`);
  });
  app.url = `http://localhost:${(JSON.parse(ready) as { port: number }).port}`;
  return app;
}

export interface RecordEntry {
  at: string;
  label: string;
  meta: Record<string, unknown>;
  text: string;
}

function parseLine(line: string): RecordEntry {
  const match = /^\[([^\]]+)\] ([^{]*)(\{.*\})$/.exec(line);
  if (!match) throw new Error(`bad chat line: ${line}`);
  const [, at = "", label = "", json = "{}"] = match;
  const meta = JSON.parse(json) as Record<string, unknown>;
  return { at, label: label.trim(), meta, text: "" };
}

/** Reads chat.txt through its documented format: a header line per entry and "> " text lines. */
export async function readChat(
  dataDir: string,
  connection: string,
  id: string,
): Promise<RecordEntry[]> {
  const file = Bun.file(join(dataDir, connection, id, "chat.txt"));
  if (!(await file.exists())) return [];
  const entries: RecordEntry[] = [];
  const bodies = new Map<RecordEntry, string[]>();
  for (const line of (await file.text()).split("\n")) {
    const last = entries.at(-1);
    if (line.startsWith(">") && last)
      bodies.set(last, [...(bodies.get(last) ?? []), line.slice(2)]);
    else if (line) entries.push(parseLine(line));
  }
  for (const [entry, lines] of bodies) entry.text = lines.join("\n");
  return entries;
}

export function messages(entries: RecordEntry[]) {
  return entries.filter((e) => e.meta.type === "message");
}
