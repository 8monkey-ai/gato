import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const src = join(import.meta.dir, "..", "src");
/** IO-near folders. Every other folder of src is core. */
const outer = ["app", "channels", "storage"];

async function importsOf(file: string): Promise<string[]> {
  const code = await readFile(file, "utf8");
  const specifiers = code.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g);
  return [...specifiers].map(([, specifier]) =>
    specifier!.startsWith(".")
      ? relative(src, resolve(dirname(file), specifier!))
      : specifier!,
  );
}

test("finds the imports of a file as paths in src", async () => {
  expect(await importsOf(join(src, "storage", "fs-store.ts"))).toContain(
    "conversation/events.ts",
  );
});

test("core modules import nothing from channels, storage or app", async () => {
  const folders = await readdir(src, { withFileTypes: true });
  const core = folders
    .filter((entry) => entry.isDirectory() && !outer.includes(entry.name))
    .map((entry) => entry.name);
  expect(core).toContain("conversation");
  expect(core).toContain("channel");

  const violations: string[] = [];
  for (const folder of core) {
    const files = await readdir(join(src, folder), { recursive: true });
    for (const file of files.filter((name) => name.endsWith(".ts"))) {
      const path = join(src, folder, file);
      for (const target of await importsOf(path)) {
        if (outer.includes(target.split("/")[0]!)) {
          violations.push(`${folder}/${file} -> ${target}`);
        }
      }
    }
  }
  expect(violations).toEqual([]);
});
