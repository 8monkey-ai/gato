export const countries = ["my", "ph"] as const;
export type Country = (typeof countries)[number];

export class CountryMarkupError extends Error {}

const blockOpen = /^:::(my|ph)\s*$/;
const inlineOpen = /(?<![\p{L}\p{N}_])(my|ph)\[/u;

export function filterCountry(text: string, country: Country): string {
  const kept: string[] = [];
  let outside: { from: number; lines: string[] } = { from: 1, lines: [] };
  const flush = (next: number) => {
    if (outside.lines.length) kept.push(filterInline(outside, country));
    outside = { from: next, lines: [] };
  };
  let block: Country | undefined;
  for (const [index, line] of text.split("\n").entries()) {
    const where = `line ${index + 1}`;
    const opened = blockOpen.exec(line.trim())?.[1] as Country | undefined;
    if (opened || line.trim() === ":::") {
      flush(index + 2);
      block = toggleBlock(block, opened, where);
    } else if (!block) {
      outside.lines.push(line);
    } else if (inlineOpen.test(line)) {
      throw new CountryMarkupError(
        `Inline country text inside a block at ${where}`,
      );
    } else if (block === country) {
      kept.push(line);
    }
  }
  if (block)
    throw new CountryMarkupError(`Country block ":::${block}" is not closed`);
  flush(0);
  return kept.join("\n");
}

function toggleBlock(
  block: Country | undefined,
  opened: Country | undefined,
  where: string,
) {
  if (opened && block)
    throw new CountryMarkupError(`Nested country block at ${where}`);
  if (!opened && !block)
    throw new CountryMarkupError(`Unopened ":::" at ${where}`);
  return opened;
}

function filterInline(
  { from, lines }: { from: number; lines: string[] },
  country: Country,
): string {
  const text = lines.join("\n");
  const where = (offset: number) =>
    `line ${from + text.slice(0, offset).split("\n").length - 1}`;
  let result = "";
  let done = 0;
  for (
    let match = inlineOpen.exec(text.slice(done));
    match;
    match = inlineOpen.exec(text.slice(done))
  ) {
    const at = done + match.index;
    const start = at + match[0].length;
    const end = closingBracket(text, start);
    if (end < 0)
      throw new CountryMarkupError(
        `Inline "${match[0]}" is not closed at ${where(at)}`,
      );
    const inner = text.slice(start, end);
    if (inlineOpen.test(inner))
      throw new CountryMarkupError(`Nested country text at ${where(at)}`);
    result += text.slice(done, at) + (match[1] === country ? inner : "");
    done = end + 1;
  }
  return result + text.slice(done);
}

function closingBracket(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === "[") depth++;
    if (text[i] === "]" && depth-- === 0) return i;
  }
  return -1;
}
