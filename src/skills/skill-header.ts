type SkillHeader =
  | { ok: true; name: string; description: string }
  | { ok: false; error: string };

const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?(?:\n|$)/;

export function parseSkillHeader(text: string): SkillHeader {
  const match = frontmatter.exec(text);
  if (!match)
    return { ok: false, error: "no YAML frontmatter between --- lines" };
  let fields: unknown;
  try {
    fields = Bun.YAML.parse(match[1] ?? "");
  } catch (error) {
    return {
      ok: false,
      error: `invalid frontmatter: ${(error as Error).message}`,
    };
  }
  if (typeof fields !== "object" || fields === null) {
    return { ok: false, error: "frontmatter is not a mapping" };
  }
  const { name, description } = fields as Record<string, unknown>;
  if (typeof name !== "string" || name === "")
    return { ok: false, error: "name is missing" };
  if (typeof description !== "string" || description.trim() === "") {
    return { ok: false, error: "description is missing" };
  }
  return { ok: true, name, description };
}
