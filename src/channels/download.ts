export async function download(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw new Error(`File download failed with status ${response.status}.`);
  }
  const mediaType = response.headers.get("content-type") ?? undefined;
  return { data: new Uint8Array(await response.arrayBuffer()), mediaType };
}
