import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Config } from './config.ts';
import type { Provider, Usage } from './providers/types.ts';
import { ProviderError } from './providers/types.ts';
import type { Cache } from './cache/index.ts';
import type { Ledger, LedgerEntry } from './accounting/ledger.ts';
import type { BudgetBreaker } from './accounting/budget.ts';
import type { RateLimiter } from './middleware/rate-limit.ts';
import type { Moderator } from './middleware/moderation.ts';
import { costOf } from './accounting/pricing.ts';
import { keyFingerprint, type Logger } from './telemetry/logger.ts';
import type { PromptRegistry } from './prompts/registry.ts';

export interface AppDependencies {
  config: Config;
  provider: Provider;
  cache: Cache;
  ledger: Ledger;
  budget: BudgetBreaker;
  rateLimiter: RateLimiter;
  moderator: Moderator;
  prompts: PromptRegistry;
  logger: Logger;
}

const completionBody = z
  .object({
    prompt: z.string().optional(),
    template: z.string().optional(),
    variables: z.record(z.string(), z.unknown()).optional(),
    model: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.int().positive().max(32_000).optional(),
  })
  .refine((body) => Boolean(body.prompt) !== Boolean(body.template), {
    message: 'provide exactly one of prompt or template',
  });

type CompletionBody = z.infer<typeof completionBody>;

function apiKeyOf(req: Request): string {
  const header = req.header('x-api-key') ?? req.header('authorization') ?? '';
  return header.replace(/^Bearer\s+/i, '').trim() || 'anonymous';
}

/** Backpressure-aware write: waits for drain rather than buffering unboundedly. */
async function write(res: Response, chunk: string): Promise<void> {
  if (!res.write(chunk)) await once(res, 'drain');
}

/** Safe for an `unknown` from a catch block, which may not be an Error. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return JSON.stringify(error) ?? 'unknown error';
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createApp(deps: AppDependencies): Express {
  const { config, provider, cache, ledger, budget, rateLimiter, moderator, prompts, logger } = deps;
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', provider: provider.name, model: config.MODEL });
  });

  app.get('/readyz', async (_req, res) => {
    const decision = await budget.check();
    // Over budget is a working service that is refusing to spend, so it stays
    // ready. A budget counter that cannot be read is not ready.
    if (!decision.allowed && decision.reason === 'unavailable') {
      res.status(503).json({ status: 'degraded', reason: 'budget counter unavailable' });
      return;
    }
    res.json({ status: 'ok' });
  });

  app.get('/admin/ledger', async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? '20') || 20, 200);
    const [summary, recent] = await Promise.all([ledger.summary(), ledger.recent(limit)]);
    res.json({ summary, recent, budget: await budget.check() });
  });

  app.get('/v1/prompts', (_req, res) => {
    res.json({ templates: prompts.list() });
  });

  /**
   * Resolves the request into a prompt, then walks the fixed chain:
   * cache → moderation → rate limit → budget. Returns a response to send, or
   * the resolved prompt to hand to the provider.
   */
  async function prepare(
    req: Request,
    res: Response,
    body: CompletionBody,
  ): Promise<
    | { kind: 'respond' }
    | { kind: 'cached'; text: string; usage: Usage; model: string }
    | { kind: 'call'; prompt: string; model: string }
  > {
    const model = body.model ?? config.MODEL;
    const apiKey = apiKeyOf(req);

    let prompt: string;
    if (body.template) {
      const rendered = prompts.render(body.template, body.variables ?? {});
      if (!rendered.ok) {
        res.status(400).json({ error: 'invalid template request', detail: rendered.error });
        return { kind: 'respond' };
      }
      prompt = rendered.prompt;
    } else {
      prompt = body.prompt ?? '';
    }

    const key = {
      model,
      prompt,
      temperature: body.temperature,
      maxTokens: body.max_tokens,
    };

    // Cache first: a hit costs nothing, so it should not be gated on a budget
    // it will not spend or a rate limit meant to protect the upstream.
    const hit = await cache.get(key);
    if (hit) {
      return { kind: 'cached', text: hit.text, usage: hit.usage, model: hit.model };
    }

    const verdict = await moderator(prompt);
    if (!verdict.allowed) {
      res.status(422).json({ error: 'prompt rejected', detail: verdict.reason });
      return { kind: 'respond' };
    }

    const rate = await rateLimiter.check(apiKey);
    if (!rate.allowed) {
      res.setHeader('retry-after', String(rate.retryAfterSeconds));
      res.status(429).json({ error: 'rate limit exceeded', retry_after: rate.retryAfterSeconds });
      return { kind: 'respond' };
    }

    const spend = await budget.check();
    if (!spend.allowed) {
      res.setHeader('retry-after', String(spend.retryAfterSeconds));
      res.status(spend.reason === 'unavailable' ? 503 : 429).json({
        error:
          spend.reason === 'unavailable'
            ? 'budget counter unavailable and BUDGET_FAIL_MODE=closed'
            : 'monthly budget exhausted',
        retry_after: spend.retryAfterSeconds,
        ...(spend.reason === 'over-budget' ? { spent_usd: spend.spentUsd } : {}),
      });
      return { kind: 'respond' };
    }

    return { kind: 'call', prompt, model };
  }

  async function settle(entry: LedgerEntry): Promise<void> {
    await ledger.record(entry);
    if (entry.costUsd !== null && !entry.cached) await budget.add(entry.costUsd);
    logger.info(
      {
        requestId: entry.requestId,
        apiKey: entry.apiKey,
        model: entry.model,
        outcome: entry.outcome,
        cached: entry.cached,
        streamed: entry.streamed,
        promptTokens: entry.promptTokens,
        completionTokens: entry.completionTokens,
        costUsd: entry.costUsd,
        estimated: entry.estimated,
      },
      'completion',
    );
  }

  app.post('/v1/complete', async (req, res) => {
    const parsed = completionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', issues: parsed.error.issues });
      return;
    }

    const requestId = randomUUID();
    const apiKey = keyFingerprint(apiKeyOf(req));
    const prepared = await prepare(req, res, parsed.data);
    if (prepared.kind === 'respond') return;

    if (prepared.kind === 'cached') {
      await settle({
        at: new Date().toISOString(),
        requestId,
        apiKey,
        provider: provider.name,
        model: prepared.model,
        promptTokens: prepared.usage.promptTokens,
        completionTokens: prepared.usage.completionTokens,
        costUsd: 0,
        estimated: false,
        cached: true,
        streamed: false,
        outcome: 'ok',
      });
      res.json({ id: requestId, text: prepared.text, model: prepared.model, cached: true });
      return;
    }

    const controller = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    try {
      const result = await provider.complete({
        model: prepared.model,
        prompt: prepared.prompt,
        temperature: parsed.data.temperature,
        maxTokens: parsed.data.max_tokens,
        signal: controller.signal,
      });

      await cache.set(
        {
          model: prepared.model,
          prompt: prepared.prompt,
          temperature: parsed.data.temperature,
          maxTokens: parsed.data.max_tokens,
        },
        { text: result.text, usage: result.usage, model: result.model },
      );

      await settle({
        at: new Date().toISOString(),
        requestId,
        apiKey,
        provider: provider.name,
        model: result.model,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        costUsd: costOf(result.model, result.usage),
        estimated: false,
        cached: false,
        streamed: false,
        outcome: 'ok',
      });

      res.json({ id: requestId, text: result.text, model: result.model, cached: false });
    } catch (error) {
      await settle({
        at: new Date().toISOString(),
        requestId,
        apiKey,
        provider: provider.name,
        model: prepared.model,
        promptTokens: provider.countTokens(prepared.prompt, prepared.model),
        completionTokens: 0,
        costUsd: null,
        estimated: true,
        cached: false,
        streamed: false,
        outcome: controller.signal.aborted ? 'aborted' : 'error',
      });

      const status = error instanceof ProviderError ? (error.status ?? 502) : 502;
      if (!res.headersSent) {
        res.status(status >= 400 && status < 600 ? status : 502).json({
          error: 'upstream failed',
          detail: describeError(error),
        });
      }
    }
  });

  app.post('/v1/complete/stream', async (req, res) => {
    const parsed = completionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', issues: parsed.error.issues });
      return;
    }

    const requestId = randomUUID();
    const apiKey = keyFingerprint(apiKeyOf(req));
    const prepared = await prepare(req, res, parsed.data);
    if (prepared.kind === 'respond') return;

    res.status(200);
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    // Proxies that buffer will hold the whole stream and defeat the point.
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders();

    if (prepared.kind === 'cached') {
      await write(res, sse('delta', { text: prepared.text }));
      await write(res, sse('done', { id: requestId, cached: true, model: prepared.model }));
      res.end();
      await settle({
        at: new Date().toISOString(),
        requestId,
        apiKey,
        provider: provider.name,
        model: prepared.model,
        promptTokens: prepared.usage.promptTokens,
        completionTokens: prepared.usage.completionTokens,
        costUsd: 0,
        estimated: false,
        cached: true,
        streamed: true,
        outcome: 'ok',
      });
      return;
    }

    // Sent before the first token so the client — and any proxy in between —
    // sees bytes immediately rather than waiting out a slow first token.
    await write(res, sse('open', { id: requestId, model: prepared.model }));

    const controller = new AbortController();
    let aborted = false;
    req.on('close', () => {
      if (!res.writableEnded) {
        aborted = true;
        // Cancels the upstream call. Without this the provider keeps
        // generating — and keeps charging — for a client that has gone.
        controller.abort();
      }
    });

    let text = '';
    let usage: Usage | undefined;
    let failure: unknown;

    try {
      for await (const event of provider.stream({
        model: prepared.model,
        prompt: prepared.prompt,
        temperature: parsed.data.temperature,
        maxTokens: parsed.data.max_tokens,
        signal: controller.signal,
      })) {
        if (event.type === 'delta') {
          text += event.text;
          await write(res, sse('delta', { text: event.text }));
        } else {
          usage = event.usage;
        }
      }
    } catch (error) {
      failure = error;
    }

    const estimated = usage === undefined;
    const finalUsage: Usage = usage ?? {
      promptTokens: provider.countTokens(prepared.prompt, prepared.model),
      completionTokens: provider.countTokens(text, prepared.model),
    };

    if (!aborted && !failure) {
      await cache.set(
        {
          model: prepared.model,
          prompt: prepared.prompt,
          temperature: parsed.data.temperature,
          maxTokens: parsed.data.max_tokens,
        },
        { text, usage: finalUsage, model: prepared.model },
      );
    }

    // Exactly one entry per request, whatever happened: a partial stream still
    // consumed tokens, and a ledger that only records successes understates the
    // bill precisely when things are going wrong.
    await settle({
      at: new Date().toISOString(),
      requestId,
      apiKey,
      provider: provider.name,
      model: prepared.model,
      promptTokens: finalUsage.promptTokens,
      completionTokens: finalUsage.completionTokens,
      costUsd: costOf(prepared.model, finalUsage),
      estimated,
      cached: false,
      streamed: true,
      outcome: aborted ? 'aborted' : failure ? 'error' : 'ok',
    });

    if (res.writableEnded) return;

    if (failure) {
      await write(res, sse('error', { message: describeError(failure) }));
    } else {
      await write(res, sse('done', { id: requestId, usage: finalUsage, estimated }));
    }
    res.end();
  });

  return app;
}
