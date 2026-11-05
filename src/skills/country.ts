import type { Country } from "../config/settings.ts";

export class CountryMarkupError extends Error {}

const inline = /(?<![A-Za-z0-9])(my|ph)\[([^\]\n]*)\]/g;
const blockLine = /^:::(my|ph)?\s*$/;

function filterInline(line: string, country: string, lineNumber: number) {
  const kept = line.replace(inline, (_, code: string, content: string) => {
    if (/(?<![A-Za-z0-9])(my|ph)\[/.test(content)) {
      throw new CountryMarkupError(
        `Nested country text on line ${lineNumber}.`,
      );
    }
    return code === country ? content : "";
  });
  if (/(?<![A-Za-z0-9])(my|ph)\[/.test(kept)) {
    throw new CountryMarkupError(
      `Unclosed country text on line ${lineNumber}.`,
    );
  }
  return kept;
}

export function filterCountry(text: string, country: Country) {
  const code = country.toLowerCase();
  let open: string | undefined;
  const kept: string[] = [];
  text.split("\n").forEach((line, index) => {
    const number = index + 1;
    const block = line.match(blockLine);
    if (block) {
      if (block[1] && open)
        throw new CountryMarkupError(`Nested country block on line ${number}.`);
      if (!block[1] && !open)
        throw new CountryMarkupError(
          `Country block end without start on line ${number}.`,
        );
      open = block[1];
      return;
    }
    if (open && /(?<![A-Za-z0-9])(my|ph)\[/.test(line)) {
      throw new CountryMarkupError(
        `Country text inside a country block on line ${number}.`,
      );
    }
    if (!open || open === code) kept.push(filterInline(line, code, number));
  });
  if (open) throw new CountryMarkupError(`Country block "${open}" has no end.`);
  return kept.join("\n");
}
