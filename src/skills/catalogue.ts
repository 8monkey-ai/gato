import type { Revision } from "./loader.ts";

export function skillCatalogue(revision: Pick<Revision, "skills">) {
  return revision.skills
    .map(
      (skill) => `- ${skill.name}: ${skill.description.replace(/\s+/g, " ")}`,
    )
    .join("\n");
}
