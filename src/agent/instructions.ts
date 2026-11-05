interface InstructionParts {
  repository: string;
  skills: { name: string; description: string; path: string }[];
  today: string;
  timezone: string;
  profile: Record<string, string>;
}

function skillCatalogue(skills: InstructionParts["skills"]) {
  if (skills.length === 0) return "";
  const lines = skills.map(
    (skill) => `- ${skill.name} (${skill.path}): ${skill.description}`,
  );
  return `## Skills\n\nBefore you answer, read each relevant skill with the read_skill tool.\n\n${lines.join("\n")}`;
}

function profileLines(profile: Record<string, string>) {
  const lines = Object.entries(profile).map(
    ([key, value]) => `- ${key}: ${value}`,
  );
  return lines.length > 0
    ? `Customer profile (private):\n${lines.join("\n")}`
    : "";
}

export function composeInstructions(parts: InstructionParts) {
  const conversation = [
    "## This conversation",
    `Today's date is ${parts.today} (${parts.timezone}).`,
    "Messages that start with [Human colleague] come from a human operator on your team. Messages that start with [Automated workflow] come from an automation. Treat them as already sent to the customer.",
    "Reply in the language and tone of the customer. Never show internal identifiers or private notes to the customer.",
    "If no reply is necessary, give no text.",
    profileLines(parts.profile),
  ];
  return [
    parts.repository,
    skillCatalogue(parts.skills),
    conversation.filter(Boolean).join("\n\n"),
  ]
    .filter((section) => section.trim() !== "")
    .join("\n\n");
}
