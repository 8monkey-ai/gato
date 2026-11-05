export async function download(url: string) {
  // Network errors can contain the URL, and Telegram file URLs contain the bot token.
  const response = await fetch(url, {
    signal: AbortSignal.timeout(60_000),
  }).catch(() => {
    throw new Error("File download failed: the file host did not answer.");
  });
  if (!response.ok) {
    throw new Error(`File download failed with status ${response.status}.`);
  }
  const mediaType = response.headers.get("content-type") ?? undefined;
  return { data: new Uint8Array(await response.arrayBuffer()), mediaType };
}
