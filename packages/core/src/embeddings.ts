import { embedMany, type EmbeddingModel } from "ai";
import type { Config } from "@vibe/config";
import type { ProviderRegistry } from "@vibe/providers";
import type { Logger } from "@vibe/shared";

/**
 * A model-agnostic text embedder. Two implementations exist — a cloud provider's
 * AI-SDK embedding model, and an optional on-device ONNX model — but the rest of
 * the memory subsystem only sees this interface, so it works the same whichever
 * is configured, and the whole semantic layer simply switches off (degrading to
 * lexical BM25 recall) when no embedder is available.
 */
export interface Embedder {
  /** Stable id (e.g. the model string) used to namespace the index, so changing
   * the embedding model forces a clean re-index instead of mixing vector spaces. */
  readonly id: string;
  /** Vector dimensionality; learned from the first embedding (0 until probed). */
  dimensions: number;
  /** Embed a batch of texts, returning one vector per input (same order). */
  embed(texts: string[]): Promise<number[][]>;
}

/** The default on-device model (small, fast, good for code/prose retrieval). */
const DEFAULT_LOCAL_MODEL = "Xenova/bge-small-en-v1.5";

/** Wrap an AI-SDK embedding model (cloud provider) as an Embedder. */
export function aiSdkEmbedder(id: string, model: EmbeddingModel<string>): Embedder {
  return {
    id,
    dimensions: 0,
    async embed(texts) {
      if (!texts.length) return [];
      const { embeddings } = await embedMany({ model, values: texts });
      return embeddings;
    },
  };
}

/**
 * On-device embeddings via `@huggingface/transformers` (an OPTIONAL peer dep,
 * imported through a non-literal specifier so tsc/the bundler don't require it).
 * Throws an actionable error when the package isn't installed; the caller treats
 * that as "no embedder" and falls back to lexical recall.
 */
export async function localEmbedder(
  modelId: string = DEFAULT_LOCAL_MODEL,
): Promise<Embedder> {
  const spec = "@huggingface/transformers";
  let pipelineFn: (task: string, model: string) => Promise<unknown>;
  try {
    const mod = (await import(spec)) as {
      pipeline: (task: string, model: string) => Promise<unknown>;
    };
    pipelineFn = mod.pipeline;
  } catch (err) {
    throw new Error(
      `on-device embeddings need the optional "${spec}" package ` +
        `(bun add ${spec}), or set memory.semantic.model to a cloud embedder: ${
          (err as Error).message
        }`,
    );
  }
  const extractor = (await pipelineFn("feature-extraction", modelId)) as (
    text: string,
    opts: { pooling: string; normalize: boolean },
  ) => Promise<{ data: ArrayLike<number> }>;
  return {
    id: `local/${modelId}`,
    dimensions: 0,
    async embed(texts) {
      const out: number[][] = [];
      for (const text of texts) {
        const res = await extractor(text, { pooling: "mean", normalize: true });
        out.push(Array.from(res.data));
      }
      return out;
    },
  };
}

/**
 * Resolve the configured embedder, or `undefined` when semantic memory is off /
 * unavailable (so callers degrade to lexical recall). A short probe embedding
 * both validates the embedder works (key present, dep installed) and learns the
 * vector dimensionality. Never throws — a missing key/dep is a graceful no-op.
 */
export async function resolveEmbedder(
  config: Config,
  registry: ProviderRegistry,
  logger?: Logger,
): Promise<Embedder | undefined> {
  const sem = config.memory.semantic;
  if (!sem.enabled) return undefined;
  const model = sem.model.trim();
  if (!model || model === "none" || model === "off") return undefined;
  try {
    const embedder =
      model === "local" || model.startsWith("local/")
        ? await localEmbedder(model === "local" ? undefined : model.slice("local/".length))
        : aiSdkEmbedder(model, await registry.embeddingModel(model, config));
    const [vec] = await embedder.embed(["probe"]);
    if (!vec?.length) {
      logger?.warn(`semantic memory disabled: embedder "${model}" returned no vector`);
      return undefined;
    }
    embedder.dimensions = vec.length;
    return embedder;
  } catch (err) {
    logger?.warn(`semantic memory disabled (lexical recall only): ${(err as Error).message}`);
    return undefined;
  }
}

/** Cosine similarity of two equal-length vectors (0 when either is degenerate). */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
