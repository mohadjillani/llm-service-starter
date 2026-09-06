import { z } from 'zod';

/**
 * Configuration is parsed once at boot and the process exits if it is wrong.
 *
 * A service that starts with a missing API key and fails on the first request
 * has moved a deploy-time problem to request time, where it costs a page
 * instead of a red pipeline. This is the pattern from env-guard, reimplemented
 * here rather than depended on so the starter stands alone.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: z.stringbool().default(false),

  PROVIDER: z.enum(['mock', 'openai', 'compatible']).default('mock'),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_BASE_URL: z.url().optional(),
  MODEL: z.string().min(1).default('gpt-4o-mini'),
  /** Per-attempt ceiling, not a total: retries each get the full budget. */
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),

  REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379/0'),

  MONTHLY_BUDGET_USD: z.coerce.number().nonnegative().default(50),
  /**
   * What to do when the budget counter cannot be read. Closed refuses the
   * request; open lets it through. Closed by default because the failure this
   * guards against is an unbounded bill, and an unavailable Redis is exactly
   * when a runaway loop is most likely to go unnoticed.
   */
  BUDGET_FAIL_MODE: z.enum(['closed', 'open']).default('closed'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),

  CACHE_MODE: z.enum(['exact', 'semantic', 'off']).default('exact'),
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  /** Cosine similarity above which a semantic cache hit is accepted. */
  SEMANTIC_THRESHOLD: z.coerce.number().min(0).max(1).default(0.95),
});

export type Config = z.infer<typeof schema>;

/** Every key the schema recognises, for the .env.example drift check. */
export function configKeys(): string[] {
  return Object.keys(schema.shape);
}

export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`invalid configuration:\n${issues}`);
  }

  const config = parsed.data;

  // Cross-field rules the schema cannot express on its own. Checked here so a
  // misconfigured provider is a startup failure rather than a 500 later.
  if (config.PROVIDER === 'openai' && !config.OPENAI_API_KEY) {
    throw new Error('invalid configuration:\n  OPENAI_API_KEY is required when PROVIDER=openai');
  }
  if (config.PROVIDER === 'compatible' && !config.OPENAI_BASE_URL) {
    throw new Error(
      'invalid configuration:\n  OPENAI_BASE_URL is required when PROVIDER=compatible',
    );
  }

  return config;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return parseConfig(env);
}
