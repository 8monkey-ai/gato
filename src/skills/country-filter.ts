import type { Country } from "./country.ts";

export type TextResult =
  { ok: true; text: string } | { ok: false; error: string };

type Block = { country: string; line: number };

const inlineMarker = /(?<!\p{L})(my|ph)\[/u;

export function filterCountry(text: string, country: Country): TextResult {
  const selected = country.toLowerCase();
  const kept: string[] = [];
  let block: Block | undefined;
  for (const [index, line] of text.split("\n").entries()) {
    const lineNumber = index + 1;
    const change = blockMarker(line.replace(/\r$/, ""), block, lineNumber);
    if (change?.error) return failure(lineNumber, change.error);
    if (change) {
      block = change.block;
      continue;
    }
    const inline = filterInline(line, selected, block !== undefined);
    if (!inline.ok) return failure(lineNumber, inline.error);
    if (!block || block.country === selected) kept.push(inline.text);
  }
  if (block) return failure(block.line, "country block is not closed");
  return { ok: true, text: kept.join("\n") };
}

function blockMarker(
  line: string,
  block: Block | undefined,
  lineNumber: number,
): { block?: Block; error?: string } | undefined {
  if (line === ":::my" || line === ":::ph") {
    if (block) {
      return {
        error: `country block opens inside the block of line ${block.line}`,
      };
    }
    return { block: { country: line.slice(3), line: lineNumber } };
  }
  if (line !== ":::") return undefined;
  return block ? {} : { error: '":::" closes no country block' };
}

function filterInline(
  line: string,
  selected: string,
  inBlock: boolean,
): TextResult {
  let text = "";
  let from = 0;
  for (const match of line.matchAll(new RegExp(inlineMarker, "gu"))) {
    const open = `"${match[0]}"`;
    if (inBlock)
      return { ok: false, error: `${open} is inside a country block` };
    const start = match.index + match[0].length;
    const end = closingBracket(line, start);
    if (end === -1) return { ok: false, error: `${open} is not closed` };
    const content = line.slice(start, end);
    if (inlineMarker.test(content))
      return { ok: false, error: `${open} contains a country section` };
    text +=
      line.slice(from, match.index) + (match[1] === selected ? content : "");
    from = end + 1;
  }
  return { ok: true, text: text + line.slice(from) };
}

function closingBracket(line: string, start: number) {
  let depth = 1;
  for (let index = start; index < line.length; index++) {
    if (line[index] === "[") depth++;
    if (line[index] === "]") depth--;
    if (depth === 0) return index;
  }
  return -1;
}

function failure(line: number, message: string): TextResult {
  return { ok: false, error: `line ${line}: ${message}` };
}
