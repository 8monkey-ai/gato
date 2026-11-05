export async function verifyModels(
  gateway: { apiKey: string; baseURL?: string },
  ids: string[],
) {
  const baseURL = gateway.baseURL ?? "https://openrouter.ai/api/v1";
  const response = await fetch(`${baseURL}/models`, {
    headers: { Authorization: `Bearer ${gateway.apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(
      `The AI gateway did not list its models (status ${response.status}).`,
    );
  const { data } = (await response.json()) as { data: { id: string }[] };
  const known = new Set(data.map((model) => model.id));
  const unknown = [...new Set(ids)].filter((id) => !known.has(id));
  if (unknown.length > 0)
    throw new Error(
      `The AI gateway does not offer the models: ${unknown.join(", ")}.`,
    );
}
