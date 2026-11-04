import path from "node:path";

type TextFiles = { files: Map<string, string>; oversized: string[] };

const decoder = new TextDecoder("utf-8", { fatal: true });

export async function readTextFiles(dir: string): Promise<TextFiles> {
  const paths = await Array.fromAsync(
    new Bun.Glob("**").scan({ cwd: dir, onlyFiles: true }),
  );
  const files = new Map<string, string>();
  const oversized: string[] = [];
  for (const relative of paths.map((p) => p.split(path.sep).join("/")).sort()) {
    const file = Bun.file(path.join(dir, relative));
    if (file.size > 256 * 1024) {
      oversized.push(relative);
      continue;
    }
    const text = decodeText(await file.bytes());
    if (text !== undefined) files.set(relative, text);
  }
  return { files, oversized };
}

function decodeText(bytes: Uint8Array) {
  try {
    const text = decoder.decode(bytes);
    return text.includes("\0") ? undefined : text;
  } catch {
    return undefined;
  }
}
