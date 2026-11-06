export const countries = ["my", "ph"] as const;
export type Country = (typeof countries)[number];

export class CountryMarkupError extends Error {}

const blockOpen = /^:::(my|ph)\s*$/;
const inlineOpen = /(?<![\p{L}\p{N}_])(my|ph)\[/u;

export function filterCountry(text: string, country: Country): string {
  const kept: string[] = [];
  let block: Country | undefined;
  for (const [index, line] of text.split("\n").entries()) {
    const where = `line ${index + 1}`;
    const opened = blockOpen.exec(line.trim())?.[1] as Country | undefined;
    if (opened || line.trim() === ":::") {
      block = toggleBlock(block, opened, where);
    } else if (!block) {
      kept.push(filterInline(line, country, where));
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

function filterInline(line: string, country: Country, where: string): string {
  let result = "";
  let rest = line;
  for (
    let match = inlineOpen.exec(rest);
    match;
    match = inlineOpen.exec(rest)
  ) {
    const start = match.index + match[0].length;
    const end = closingBracket(rest, start);
    if (end < 0)
      throw new CountryMarkupError(
        `Inline "${match[0]}" is not closed at ${where}`,
      );
    const inner = rest.slice(start, end);
    if (inlineOpen.test(inner))
      throw new CountryMarkupError(`Nested country text at ${where}`);
    result += rest.slice(0, match.index) + (match[1] === country ? inner : "");
    rest = rest.slice(end + 1);
  }
  return result + rest;
}

function closingBracket(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === "[") depth++;
    if (text[i] === "]" && depth-- === 0) return i;
  }
  return -1;
}
