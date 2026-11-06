import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");

export type LogLine = { event: string; level: string; [key: string]: unknown };

export async function tempDir(prefix = "gato-e2e-") {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function waitUntil<T>(
  check: () => T | Promise<T>,
  timeoutMs = 5000,
  what = "condition",
): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

function collect(proc: Bun.Subprocess<"ignore", "pipe", "pipe">) {
  const logs: LogLine[] = [];
  const output: string[] = [];
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
      const lines = (buffer + decoder.decode(chunk, { stream: true })).split(
        "\n",
      );
      buffer = lines.pop() ?? "";
      output.push(...lines);
      for (const line of lines) {
        try {
          logs.push(JSON.parse(line) as LogLine);
        } catch {
          // Not a log line.
        }
      }
    }
  };
  void read(proc.stdout);
  void read(proc.stderr);
  return { logs, output };
}

export async function startApp(env: Record<string, string>) {
  const proc = Bun.spawn(["bun", "src/main.ts"], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const { logs, output } = collect(proc);
  const started = await waitUntil(
    () =>
      logs.find((l) =>
        ["harness.ready", "harness.start_failed"].includes(l.event),
      ) ??
      (proc.exitCode !== null
        ? { event: "exited", level: "error" }
        : undefined),
    10_000,
    "the harness to start",
  );
  return {
    url: `http://127.0.0.1:${String(started.port)}`,
    started: started.event === "harness.ready",
    startError: typeof started.error === "string" ? started.error : "",
    logs,
    output,
    proc,
    waitForLog: (
      event: string,
      match: (line: LogLine) => boolean = () => true,
      timeoutMs = 5000,
    ) =>
      waitUntil(
        () => logs.find((l) => l.event === event && match(l)),
        timeoutMs,
        `log ${event}`,
      ),
    async stop() {
      if (proc.exitCode === null) proc.kill("SIGTERM");
      await proc.exited;
    },
  };
}

export type App = Awaited<ReturnType<typeof startApp>>;

export const defaultAgents =
  "You help customers of Gato Coffee.\n:::my\nPrices are in RM.\n:::\n:::ph\nPrices are in PHP.\n:::\n";

export const skillFile = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

export async function writeSkills(files: Record<string, string> = {}) {
  const dir = await tempDir("gato-skills-");
  const all = {
    "AGENTS.md": defaultAgents,
    "skills/menu/SKILL.md": skillFile(
      "menu",
      "The menu my[in RM]ph[in PHP]. Use for prices.",
      "Latte costs my[RM 12]ph[PHP 150].",
    ),
    ...files,
  };
  for (const [path, text] of Object.entries(all))
    await Bun.write(join(dir, path), text);
  return dir;
}

export type ChatEntry = {
  at: string;
  tag: string;
  meta: Record<string, unknown>;
  text?: string;
};

export async function readChat(
  dataDir: string,
  connection: string,
  contact: string,
): Promise<ChatEntry[]> {
  const file = Bun.file(join(dataDir, connection, contact, "chat.txt"));
  if (!(await file.exists())) return [];
  return (await file.text())
    .split(/\n(?=\[)/)
    .filter((block) => block.trim())
    .map((block) => {
      const [head = "", ...body] = block.replace(/\n+$/, "").split("\n");
      const match = /^\[([^\]]+)\] (\w+)(?: (\{.*\}))?$/.exec(head);
      const text = body.length
        ? body.map((line) => line.slice(2)).join("\n")
        : undefined;
      return {
        at: match?.[1] ?? "",
        tag: match?.[2] ?? "damaged",
        meta: match?.[3]
          ? (JSON.parse(match[3]) as Record<string, unknown>)
          : {},
        ...(text === undefined ? {} : { text }),
      };
    });
}

export async function writeChat(
  dataDir: string,
  connection: string,
  contact: string,
  content: string,
) {
  await Bun.write(join(dataDir, connection, contact, "chat.txt"), content);
}

export const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();
