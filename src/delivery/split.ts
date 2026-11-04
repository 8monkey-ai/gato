export type DeliveryBoundary = "paragraph" | "line" | "whole";

const separators = {
  paragraph: /\n[ \t\r]*\n/,
  line: /\n/,
  whole: undefined,
};

const cleanParts = (pieces: string[]) =>
  pieces.map((piece) => piece.trim()).filter((piece) => piece !== "");

export function createSplitter(boundary: DeliveryBoundary) {
  const separator = separators[boundary];
  let buffer = "";
  return {
    push(delta: string) {
      buffer += delta;
      if (!separator) return [];
      const pieces = buffer.split(separator);
      buffer = pieces.pop() ?? "";
      return cleanParts(pieces);
    },
    end() {
      const rest = cleanParts([buffer]);
      buffer = "";
      return rest;
    },
  };
}
