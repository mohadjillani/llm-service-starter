import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Usage } from '../providers/types.ts';

export interface CacheKeyInput {
  model: string;
  prompt: string;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
}

export interface CacheEntry {
  text: string;
  usage: Usage;
  model: string;
}

export interface Cache {
  get(input: CacheKeyInput): Promise<CacheEntry | null>;
  set(input: CacheKeyInput, entry: CacheEntry): Promise<void>;
}

/**
 * The key covers every input that changes the answer.
 *
 * Temperature is part of it deliberately: two requests with the same prompt and
 * different temperatures are not asking for the same thing. Anything above zero
 * is a request for a fresh sample, which is why the exact cache refuses to
 * serve those at all.
 */
export function cacheKey(input: CacheKeyInput): string {
  const material = JSON.stringify({
    model: input.model,
    prompt: input.prompt,
    temperature: input.temperature ?? 0,
    maxTokens: input.maxTokens ?? null,
  });
  return `cache:exact:${createHash('sha256').update(material).digest('hex')}`;
}

export function isCacheable(input: CacheKeyInput): boolean {
  return (input.temperature ?? 0) === 0;
}

export function createNullCache(): Cache {
  return {
    get: () => Promise.resolve(null),
    set: () => Promise.resolve(),
  };
}

export function createExactCache(redis: Redis, ttlSeconds: number): Cache {
  return {
    async get(input) {
      if (!isCacheable(input)) return null;
      const raw = await redis.get(cacheKey(input));
      return raw === null ? null : (JSON.parse(raw) as CacheEntry);
    },

    async set(input, entry) {
      if (!isCacheable(input)) return;
      await redis.setex(cacheKey(input), ttlSeconds, JSON.stringify(entry));
    },
  };
}

export type Embedder = (text: string) => Promise<number[]>;

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * A deterministic stand-in for a real embedding model.
 *
 * It hashes word trigrams into a fixed number of buckets, which makes texts
 * that share wording land close together and lets the semantic cache be tested
 * without a network call or a key. It is not a semantic model — it cannot tell
 * that two differently worded sentences mean the same thing, which is precisely
 * what a real embedding is for. `npm run demo` and the tests use it; a real
 * deployment passes a provider-backed embedder instead.
 */
export function createDeterministicEmbedder(dimensions = 64): Embedder {
  return (text: string) => {
    const vector = new Array<number>(dimensions).fill(0);
    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);

    for (let i = 0; i < words.length; i += 1) {
      const gram = words.slice(i, i + 3).join(' ');
      const digest = createHash('sha256').update(gram).digest();
      const bucket = digest.readUInt32BE(0) % dimensions;
      vector[bucket] = (vector[bucket] ?? 0) + 1;
    }
    return Promise.resolve(vector);
  };
}

export interface SemanticCacheOptions {
  ttlSeconds: number;
  threshold: number;
  embed: Embedder;
  /** How many recent entries to compare against. */
  window?: number;
}

const SEMANTIC_INDEX = 'cache:semantic:index';

/**
 * Matches prompts that are close rather than identical.
 *
 * The implementation is a linear scan over the most recent N entries, which is
 * honest about what it is: adequate for a small cache and completely wrong for
 * a large one. A real deployment wants a vector index, and swapping this for
 * one should not touch anything outside this file — which is the reason the
 * cache is an interface.
 *
 * It is off by default. A near-match is still a different question, and serving
 * a stored answer to it is a product decision, not a performance one.
 *
 * SEMANTIC_THRESHOLD is not portable between embedders. Cosine similarity has
 * no universal scale: the trigram stand-in in this file scores a near-identical
 * pair around 0.7, where a real embedding model would put the same pair well
 * above 0.9. Changing the embedder means re-measuring the threshold — the
 * shipped default suits a real model, not the stand-in.
 */
export function createSemanticCache(redis: Redis, options: SemanticCacheOptions): Cache {
  const window = options.window ?? 200;

  return {
    async get(input) {
      if (!isCacheable(input)) return null;

      const exact = await redis.get(cacheKey(input));
      if (exact !== null) return JSON.parse(exact) as CacheEntry;

      const embedding = await options.embed(input.prompt);
      const candidates = await redis.lrange(SEMANTIC_INDEX, 0, window - 1);

      let best: { score: number; entry: CacheEntry } | null = null;
      for (const raw of candidates) {
        const candidate = JSON.parse(raw) as {
          model: string;
          embedding: number[];
          entry: CacheEntry;
        };
        if (candidate.model !== input.model) continue;
        const score = cosineSimilarity(embedding, candidate.embedding);
        if (score >= options.threshold && (!best || score > best.score)) {
          best = { score, entry: candidate.entry };
        }
      }
      return best?.entry ?? null;
    },

    async set(input, entry) {
      if (!isCacheable(input)) return;
      await redis.setex(cacheKey(input), options.ttlSeconds, JSON.stringify(entry));

      const embedding = await options.embed(input.prompt);
      await redis
        .multi()
        .lpush(SEMANTIC_INDEX, JSON.stringify({ model: input.model, embedding, entry }))
        .ltrim(SEMANTIC_INDEX, 0, window - 1)
        .expire(SEMANTIC_INDEX, options.ttlSeconds)
        .exec();
    },
  };
}
