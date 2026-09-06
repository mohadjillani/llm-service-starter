import { priceFor } from '../accounting/pricing.ts';
import {
  ProviderError,
  isRetryableStatus,
  type CompletionRequest,
  type Provider,
  type StreamEvent,
} from './types.ts';

/**
 * An OpenAI-shaped endpoint that is not OpenAI: a local runtime, a gateway, a
 * hosted open-weights model.
 *
 * It exists as a separate adapter rather than a base URL on the official SDK
 * because "OpenAI-compatible" is a claim about the request shape, not the
 * response. In practice these endpoints differ in three ways that matter here,
 * and each one is a place where assuming otherwise produces wrong numbers
 * rather than a clean failure:
 *
 *  - they usually omit `usage` from streamed responses, so cost has to be
 *    estimated locally instead of read;
 *  - their token counts do not match any tiktoken encoding, so the estimate is
 *    an approximation and is labelled as one;
 *  - they report overload as whatever their proxy felt like, so retry decisions
 *    come from the status code rather than from an error type.
 */
export interface CompatibleOptions {
  baseURL: string;
  apiKey?: string | undefined;
  fetchImpl?: typeof fetch;
}

interface ChatResponse {
  model?: string;
  choices?: { message?: { content?: string }; delta?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function createCompatibleProvider(options: CompatibleOptions): Provider {
  const doFetch = options.fetchImpl ?? fetch;
  const endpoint = `${options.baseURL.replace(/\/$/, '')}/chat/completions`;

  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
  });

  // No shared tokenizer, so four characters per token — good enough to keep a
  // budget check honest, and never presented as an exact count.
  const countTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

  async function post(request: CompletionRequest, stream: boolean): Promise<Response> {
    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          model: request.model,
          messages: [{ role: 'user', content: request.prompt }],
          stream,
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
        }),
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ProviderError('aborted', undefined, false, { cause: error });
      }
      throw new ProviderError(
        error instanceof Error ? error.message : String(error),
        undefined,
        true,
        {
          cause: error,
        },
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ProviderError(
        `upstream returned ${String(response.status)}: ${body.slice(0, 200)}`,
        response.status,
        isRetryableStatus(response.status),
      );
    }
    return response;
  }

  return {
    name: 'openai-compatible',
    countTokens,
    pricing: priceFor,

    async complete(request: CompletionRequest) {
      const response = await post(request, false);
      const body = (await response.json()) as ChatResponse;
      const text = body.choices?.[0]?.message?.content ?? '';
      return {
        text,
        model: body.model ?? request.model,
        usage: {
          promptTokens: body.usage?.prompt_tokens ?? countTokens(request.prompt),
          completionTokens: body.usage?.completion_tokens ?? countTokens(text),
        },
      };
    },

    async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
      const response = await post(request, true);
      if (!response.body) throw new ProviderError('upstream sent no body', undefined, true);

      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffered = '';
      let text = '';
      let usage: { promptTokens: number; completionTokens: number } | undefined;

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += value;

          // SSE frames are separated by a blank line; a chunk can split one.
          const frames = buffered.split('\n\n');
          buffered = frames.pop() ?? '';

          for (const frame of frames) {
            const line = frame.split('\n').find((candidate) => candidate.startsWith('data:'));
            if (!line) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;

            const parsed = JSON.parse(payload) as ChatResponse;
            if (parsed.usage?.prompt_tokens !== undefined) {
              usage = {
                promptTokens: parsed.usage.prompt_tokens,
                completionTokens: parsed.usage.completion_tokens ?? 0,
              };
            }
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              text += delta;
              yield { type: 'delta', text: delta };
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }

      // Most of these endpoints never send usage on a stream, so fall back to
      // the local estimate rather than recording a free request.
      yield {
        type: 'done',
        usage: usage ?? {
          promptTokens: countTokens(request.prompt),
          completionTokens: countTokens(text),
        },
      };
    },
  };
}
