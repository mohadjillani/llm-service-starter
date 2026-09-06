import { describe, expect, it } from 'vitest';
import {
  cacheKey,
  cosineSimilarity,
  createDeterministicEmbedder,
  isCacheable,
} from '../../src/cache/index.ts';
import { createPromptRegistry, parseTemplate } from '../../src/prompts/registry.ts';

describe('cache key', () => {
  it('is stable for the same inputs', () => {
    const input = { model: 'gpt-4o-mini', prompt: 'hello', temperature: 0 };
    expect(cacheKey(input)).toBe(cacheKey({ ...input }));
  });

  it('separates different models and different prompts', () => {
    const a = cacheKey({ model: 'gpt-4o-mini', prompt: 'hello' });
    const b = cacheKey({ model: 'gpt-4o', prompt: 'hello' });
    const c = cacheKey({ model: 'gpt-4o-mini', prompt: 'hello!' });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('treats max_tokens as part of the question', () => {
    expect(cacheKey({ model: 'm', prompt: 'p', maxTokens: 10 })).not.toBe(
      cacheKey({ model: 'm', prompt: 'p', maxTokens: 20 }),
    );
  });

  it('refuses to cache anything sampled at a non-zero temperature', () => {
    // Asking twice at temperature 0.7 is asking for two samples, not one
    // answer served twice.
    expect(isCacheable({ model: 'm', prompt: 'p', temperature: 0 })).toBe(true);
    expect(isCacheable({ model: 'm', prompt: 'p' })).toBe(true);
    expect(isCacheable({ model: 'm', prompt: 'p', temperature: 0.7 })).toBe(false);
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors and 0 for orthogonal ones', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it('is 0 when either side is empty rather than NaN', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([], [1, 1])).toBe(0);
  });
});

describe('deterministic embedder', () => {
  it('gives the same vector for the same text', async () => {
    const embed = createDeterministicEmbedder(32);
    expect(await embed('summarise this passage')).toEqual(await embed('summarise this passage'));
  });

  it('scores a near-identical sentence above an unrelated one', async () => {
    const embed = createDeterministicEmbedder(128);
    const base = await embed('summarise the quarterly revenue report for the board');
    const near = await embed('summarise the quarterly revenue report for the board please');
    const far = await embed('write a limerick about a cat that lost its hat');

    expect(cosineSimilarity(base, near)).toBeGreaterThan(cosineSimilarity(base, far));
  });
});

describe('prompt templates', () => {
  it('parses the version out of the filename', () => {
    const template = parseTemplate(
      'summarize@v3.md',
      '---\nmodel: gpt-4o-mini\nvariables:\n  text: string\n---\nSummarise {{text}}\n',
    );
    expect(template).toMatchObject({ name: 'summarize', version: 3, id: 'summarize@v3' });
    expect(template.body).toBe('Summarise {{text}}');
  });

  it('rejects a filename without a version', () => {
    expect(() => parseTemplate('summarize.md', '---\n---\nbody')).toThrow(/name@vN/);
  });

  it('rejects a file with no frontmatter', () => {
    expect(() => parseTemplate('summarize@v1.md', 'just a body')).toThrow(/frontmatter/);
  });

  it('renders a template with its declared variables', () => {
    const registry = createPromptRegistry();
    const result = registry.render('summarize@v1', { text: 'a long article', max_words: 40 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prompt).toContain('a long article');
      expect(result.prompt).toContain('40');
      expect(result.prompt).not.toContain('{{');
    }
  });

  it('rejects an undeclared variable rather than ignoring it', () => {
    const registry = createPromptRegistry();
    const result = registry.render('summarize@v1', {
      text: 'x',
      max_words: 10,
      tone: 'formal',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a variable of the wrong type', () => {
    const registry = createPromptRegistry();
    const result = registry.render('summarize@v1', { text: 'x', max_words: 'forty' });
    expect(result.ok).toBe(false);
  });

  it('names the versions it knows when asked for one it does not', () => {
    const registry = createPromptRegistry();
    const result = registry.render('summarize@v99', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('summarize@v1');
  });

  it('keeps both versions of a template loadable at once', () => {
    const registry = createPromptRegistry();
    const ids = registry.list().map((template) => template.id);
    expect(ids).toContain('summarize@v1');
    expect(ids).toContain('summarize@v2');
  });
});
