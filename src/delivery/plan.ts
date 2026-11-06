export type Outgoing =
  { kind: "text"; text: string } | { kind: "video"; url: string };

export interface VideoPolicy {
  links: "attachment" | "text";
  surroundingText: "replace" | "separate";
  approvedUrls: string[];
}

const url = /https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/g;

function splitText(text: string, limit: number): Outgoing[] {
  const pieces: Outgoing[] = [];
  let rest = text;
  while (rest.length > limit) {
    const space = rest.lastIndexOf(" ", limit);
    const cut = space > limit / 2 ? space : limit;
    pieces.push({ kind: "text", text: rest.slice(0, cut).trim() });
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push({ kind: "text", text: rest });
  return pieces;
}

function withVideos(
  part: string,
  approved: RegExpExecArray[],
  policy: VideoPolicy,
): Outgoing[] {
  if (policy.surroundingText === "replace")
    return approved.map((match) => ({ kind: "video", url: match[0] }));
  const items: Outgoing[] = [];
  let position = 0;
  for (const match of approved) {
    const before = part.slice(position, match.index).trim();
    if (before) items.push({ kind: "text", text: before });
    items.push({ kind: "video", url: match[0] });
    position = match.index + match[0].length;
  }
  const after = part.slice(position).trim();
  if (after) items.push({ kind: "text", text: after });
  return items;
}

/** Decides before sending how one part reaches a channel, so a failed send never causes a second form of the same part. */
export function planPart(
  part: string,
  policy: VideoPolicy,
  channel: { textLimit: number; sendsVideo: boolean },
): Outgoing[] {
  const approved = [...part.matchAll(url)].filter((match) =>
    policy.approvedUrls.some((prefix) => match[0].startsWith(prefix)),
  );
  const convert =
    policy.links === "attachment" && channel.sendsVideo && approved.length > 0;
  const items = convert
    ? withVideos(part, approved, policy)
    : [{ kind: "text" as const, text: part }];
  return items.flatMap((item) =>
    item.kind === "text" ? splitText(item.text, channel.textLimit) : [item],
  );
}
