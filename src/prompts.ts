const names = [
  "agent",
  "summary",
  "image",
  "document",
  "audio",
  "nudge",
] as const;

export type Prompts = Record<(typeof names)[number], string>;

/** The prompts folder of the repository is the only source of harness instructions. */
export async function loadPrompts(): Promise<Prompts> {
  const texts = await Promise.all(
    names.map(async (name) => {
      const file = Bun.file(new URL(`../prompts/${name}.md`, import.meta.url));
      const text = (await file.exists()) ? (await file.text()).trim() : "";
      if (!text) throw new Error(`prompts/${name}.md is missing or empty`);
      return [name, text] as const;
    }),
  );
  return Object.fromEntries(texts) as Prompts;
}
