const link = /\[([^\]\n]+)\]\(([^\s)]+)\)/g;
const bold = /(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g;
const emphasis =
  /(?<![\p{L}\p{N}*_])([*_])(?=\S)(.+?)(?<=\S)\1(?![\p{L}\p{N}*_])/gu;

const prose = (text: string) =>
  text
    .replace(link, "$1 ($2)")
    .split(/(https?:\/\/\S+)/)
    .map((part, index) =>
      index % 2 === 0 ? part.replace(bold, "$2").replace(emphasis, "$2") : part,
    )
    .join("");

// Telegram shows Markdown markers literally, so simple Markdown becomes plain text.
export function plainText(markdown: string): string {
  return markdown
    .replace(/^#{1,6}[ \t]+/gm, "")
    .split(/(`[^`\n]+`)/)
    .map((part, index) => (index % 2 === 0 ? prose(part) : part.slice(1, -1)))
    .join("");
}
