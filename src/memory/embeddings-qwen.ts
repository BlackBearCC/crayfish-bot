import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";
import { requireApiKey, resolveApiKeyForProvider } from "../agents/model-auth.js";

export type QwenEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  model: string;
};

export const DEFAULT_QWEN_EMBEDDING_MODEL = "text-embedding-v4";
const DEFAULT_QWEN_BASE_URL =
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-embedding/public/embeddings";

export function normalizeQwenModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return DEFAULT_QWEN_EMBEDDING_MODEL;
  }
  if (trimmed.startsWith("qwen/")) {
    return trimmed.slice("qwen/".length);
  }
  return trimmed;
}

export async function createQwenEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: QwenEmbeddingClient }> {
  const client = await resolveQwenEmbeddingClient(options);
  const url = client.baseUrl;

  const embed = async (input: string[]): Promise<number[][]> => {
    if (input.length === 0) {
      return [];
    }
    const res = await fetch(url, {
      method: "POST",
      headers: client.headers,
      body: JSON.stringify({ 
        model: client.model, 
        input 
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`qwen embeddings failed: ${res.status} ${text}`);
    }
    const payload = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const data = payload.data ?? [];
    return data.map((entry) => entry.embedding ?? []);
  };

  return {
    provider: {
      id: "qwen",
      model: client.model,
      embedQuery: async (text) => {
        const [vec] = await embed([text]);
        return vec ?? [];
      },
      embedBatch: embed,
    },
    client,
  };
}

export async function resolveQwenEmbeddingClient(
  options: EmbeddingProviderOptions,
): Promise<QwenEmbeddingClient> {
  const remote = options.remote;
  const remoteApiKey = remote?.apiKey?.trim();
  const remoteBaseUrl = remote?.baseUrl?.trim();

  const apiKey = remoteApiKey
    ? remoteApiKey
    : requireApiKey(
        await resolveApiKeyForProvider({
          provider: "qwen",
          cfg: options.config,
          agentDir: options.agentDir,
        }),
        "qwen",
      );

  const providerConfig = options.config.models?.providers?.qwen;
  const baseUrl = remoteBaseUrl || providerConfig?.baseUrl?.trim() || DEFAULT_QWEN_BASE_URL;
  const headerOverrides = Object.assign({}, providerConfig?.headers, remote?.headers);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...headerOverrides,
  };
  const model = normalizeQwenModel(options.model);
  return { baseUrl, headers, model };
}