import type { SkillsRevision } from "../skills/checkout.ts";
import type { Country } from "../skills/country.ts";

const countryNames: Record<Country, string> = {
  my: "Malaysia (MY)",
  ph: "the Philippines (PH)",
};

export function localDate(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(date);
}

export function composeInstructions(options: {
  base: string;
  skills: SkillsRevision;
  country: Country;
  timezone: string;
  now: Date;
  customerName?: string;
  canHandOff: boolean;
}): string {
  const catalogue = options.skills.skills
    .map(
      (skill) =>
        `- ${skill.name}: ${skill.description} (read_skill path: ${skill.path})`,
    )
    .join("\n");
  return [
    options.base,
    `Country of this service: ${countryNames[options.country]}. The country selects business rules, not the reply language.`,
    `Today's date: ${localDate(options.now, options.timezone)} (${options.timezone}).`,
    options.customerName &&
      `Customer name, as the channel gives it: ${options.customerName}.`,
    options.canHandOff
      ? "The handoff tool is available in this channel."
      : "This channel has no handoff to a colleague.",
    `# Repository instructions\n\n${options.skills.instructions}`,
    `# Skills\n\n${catalogue || "(no skills)"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
