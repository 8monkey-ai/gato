import type { DeliverySettings } from "../config/settings.ts";

const boundaries = { paragraph: /\n\s*\n/, line: /\n/ } as const;

export function createSplitter(boundary: DeliverySettings["boundary"]) {
  let buffer = "";
  return {
    push(delta: string) {
      buffer += delta;
      if (boundary === "whole") return [];
      const pieces = buffer.split(boundaries[boundary]);
      buffer = pieces.pop()!;
      return pieces.filter((piece) => piece.trim() !== "");
    },
    flush() {
      const rest = buffer;
      buffer = "";
      return rest.trim() === "" ? [] : [rest];
    },
  };
}

export function splitAll(text: string, boundary: DeliverySettings["boundary"]) {
  const splitter = createSplitter(boundary);
  return [...splitter.push(text), ...splitter.flush()];
}
