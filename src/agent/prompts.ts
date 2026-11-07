const names = [
  "conversation",
  "summary",
  "prepare-image",
  "prepare-document",
  "prepare-audio",
  "nudge",
  "tool-read-skill",
  "tool-handoff",
] as const;

export type Prompts = Record<(typeof names)[number], string>;

export async function loadPrompts(): Promise<Prompts> {
  const entries = await Promise.all(
    names.map(async (name) => {
      const text = (
        await Bun.file(
          new URL(`../../prompts/${name}.md`, import.meta.url),
        ).text()
      ).trim();
      if (!text) throw new Error(`Prompt file prompts/${name}.md is empty`);
      return [name, text] as const;
    }),
  );
  return Object.fromEntries(entries) as Prompts;
}

export function fillTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (whole, key: string) => values[key] ?? whole,
  );
}
