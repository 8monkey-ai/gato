/** Splits streamed text into parts at the boundary. Each part is emitted as soon as it is complete. */
export function createSegmenter(
  boundary: string,
  emit: (part: string) => void,
) {
  let buffer = "";
  const emitPart = (part: string) => {
    if (part.trim()) emit(part.trim());
  };
  return {
    push(text: string) {
      buffer += text;
      for (
        let index = buffer.indexOf(boundary);
        index >= 0;
        index = buffer.indexOf(boundary)
      ) {
        emitPart(buffer.slice(0, index));
        buffer = buffer.slice(index + boundary.length);
      }
    },
    flush() {
      emitPart(buffer);
      buffer = "";
    },
  };
}
