export type Country = "my" | "ph";

const inlineMarker = /(?<![A-Za-z0-9_])(my|ph)\[/g;
const anyInlineMarker = /(?<![A-Za-z0-9_])(my|ph)\[/;

function closingBracket(line: string, start: number): number {
  let depth = 1;
  for (let index = start; index < line.length; index++) {
    if (line[index] === "[") depth++;
    if (line[index] === "]" && --depth === 0) return index;
  }
  return -1;
}

function filterInline(line: string, country: Country, inBlock: boolean) {
  let result = "";
  let position = 0;
  for (const match of line.matchAll(inlineMarker)) {
    if (inBlock) throw new Error("inline country text inside a country block");
    const contentStart = match.index + match[0].length;
    const end = closingBracket(line, contentStart);
    if (end < 0) throw new Error(`unclosed ${match[1]}[ marker`);
    const content = line.slice(contentStart, end);
    if (anyInlineMarker.test(content))
      throw new Error("nested country markers");
    result += line.slice(position, match.index);
    if (match[1] === country) result += content;
    position = end + 1;
  }
  return result + line.slice(position);
}

/**
 * Keeps common text and the selected country's text, and removes all markers.
 * Throws when the markup is malformed or ambiguous.
 */
export function filterCountry(text: string, country: Country): string {
  const kept: string[] = [];
  let block: Country | undefined;
  text.split("\n").forEach((line, index) => {
    const marker = line.trim();
    try {
      if (marker === ":::my" || marker === ":::ph") {
        if (block) throw new Error("country blocks cannot nest");
        block = marker.slice(3) as Country;
      } else if (marker === ":::") {
        if (!block) throw new Error("block end without a country block");
        block = undefined;
      } else if (!block || block === country) {
        kept.push(filterInline(line, country, block !== undefined));
      } else {
        filterInline(line, country, true);
      }
    } catch (error) {
      throw new Error(`line ${index + 1}: ${(error as Error).message}`, {
        cause: error,
      });
    }
  });
  if (block) throw new Error(`unclosed :::${block} block`);
  return kept.join("\n");
}
