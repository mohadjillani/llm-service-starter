export interface CompletionRequest {
  model: string;
  prompt: string;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  /** Cancels the upstream call when the client goes away. */
  signal?: AbortSignal | undefined;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface CompletionResult {
  text: string;
  usage: Usage;
  model: string;
}

/**
 * A streamed response is a sequence of deltas followed by exactly one `done`.
 *
 * `usage` is optional on `done` because not every provider reports it on a
 * stream — the OpenAI-compatible endpoints commonly do not. Callers reconcile
 * against a local estimate when it is missing rather than pretending the cost
 * is zero.
 */
export type StreamEvent =
  { type: 'delta'; text: string } | { type: 'done'; usage?: Usage | undefined };

export interface Price {
  /** US dollars per million tokens. */
  inputPerMillion: number;
  outputPerMillion: number;
  /** Where the figure came from, so a stale table can be traced. */
  source: string;
  asOf: string;
}

export interface Provider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
  stream(request: CompletionRequest): AsyncIterable<StreamEvent>;
  /** Local estimate, used before the call and to reconcile after it. */
  countTokens(text: string, model: string): number;
  pricing(model: string): Price | null;
}

/**
 * Errors a retry is allowed to consider. Anything else — a 400, a refusal, a
 * bad key — is a fact about the request and retrying it only spends money.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ProviderError';
  }
}

export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true; // network-level failure
  return status === 408 || status === 429 || status >= 500;
}
