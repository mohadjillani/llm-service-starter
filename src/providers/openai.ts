import OpenAI from 'openai';
import { getEncodingNameForModel, getEncoding, type TiktokenEncoding } from 'js-tiktoken';
import { priceFor } from '../accounting/pricing.ts';
import {
  ProviderError,
  isRetryableStatus,
  type CompletionRequest,
  type Provider,
  type StreamEvent,
} from './types.ts';

const encoders = new Map<TiktokenEncoding, ReturnType<typeof getEncoding>>();

/**
 * Token counts come from the same tokenizer the API bills against, so the
 * pre-flight estimate and the reported usage are comparable. Encoders are
 * cached because building one parses a sizeable table.
 */
export function countTokensFor(text: string, model: string): number {
  let encoding: TiktokenEncoding;
  try {
    encoding = getEncodingNameForModel(model as Parameters<typeof getEncodingNameForModel>[0]);
  } catch {
    // An unknown model name is not a reason to fail a request; o200k_base is
    // the current default and close enough for a budget pre-check.
    encoding = 'o200k_base';
  }

  let encoder = encoders.get(encoding);
  if (!encoder) {
    encoder = getEncoding(encoding);
    encoders.set(encoding, encoder);
  }
  return encoder.encode(text).length;
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof OpenAI.APIError) {
    // The SDK types `status` loosely; narrow it before it reaches the policy.
    const status: number | undefined = typeof error.status === 'number' ? error.status : undefined;
    return new ProviderError(error.message, status, isRetryableStatus(status), { cause: error });
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new ProviderError('aborted', undefined, false, { cause: error });
  }
  // No status means it never reached the API — a DNS failure, a reset
  // connection — which is the case retrying exists for.
  return new ProviderError(
    error instanceof Error ? error.message : String(error),
    undefined,
    true,
    {
      cause: error,
    },
  );
}

export interface OpenAiOptions {
  apiKey: string;
  baseURL?: string | undefined;
}

export function createOpenAiProvider(options: OpenAiOptions): Provider {
  const client = new OpenAI({
    apiKey: options.apiKey,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    // Retries are this service's job: it has to decide about them per attempt
    // and stop once a stream has started, which the SDK cannot know.
    maxRetries: 0,
  });

  return {
    name: 'openai',
    countTokens: countTokensFor,
    pricing: priceFor,

    async complete(request: CompletionRequest) {
      try {
        const response = await client.chat.completions.create(
          {
            model: request.model,
            messages: [{ role: 'user', content: request.prompt }],
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
            ...(request.maxTokens === undefined
              ? {}
              : { max_completion_tokens: request.maxTokens }),
          },
          { signal: request.signal },
        );

        const text = response.choices[0]?.message.content ?? '';
        return {
          text,
          model: response.model,
          usage: {
            promptTokens:
              response.usage?.prompt_tokens ?? countTokensFor(request.prompt, request.model),
            completionTokens:
              response.usage?.completion_tokens ?? countTokensFor(text, request.model),
          },
        };
      } catch (error) {
        throw toProviderError(error);
      }
    },

    async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
      try {
        const stream = await client.chat.completions.create(
          {
            model: request.model,
            messages: [{ role: 'user', content: request.prompt }],
            stream: true,
            // Without this the stream carries no usage at all and every cost
            // would be an estimate.
            stream_options: { include_usage: true },
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
            ...(request.maxTokens === undefined
              ? {}
              : { max_completion_tokens: request.maxTokens }),
          },
          { signal: request.signal },
        );

        let promptTokens: number | undefined;
        let completionTokens: number | undefined;

        for await (const chunk of stream) {
          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens;
            completionTokens = chunk.usage.completion_tokens;
          }
          const delta = chunk.choices[0]?.delta.content;
          if (delta) yield { type: 'delta', text: delta };
        }

        yield {
          type: 'done',
          usage:
            promptTokens === undefined || completionTokens === undefined
              ? undefined
              : { promptTokens, completionTokens },
        };
      } catch (error) {
        throw toProviderError(error);
      }
    },
  };
}
