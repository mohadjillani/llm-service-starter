export interface ModerationVerdict {
  allowed: boolean;
  reason?: string;
}

export type Moderator = (prompt: string) => Promise<ModerationVerdict>;

/**
 * A deliberately minimal input check, placed where a real one would go.
 *
 * It is a length ceiling and a small denylist — not content moderation, and the
 * README says so. Shipping a stub that looks like moderation would be worse
 * than shipping none, so what this actually buys is the position in the chain:
 * moderation runs after the cache (a cached answer was already checked when it
 * was stored) and before the budget guard (a request that will be refused
 * should not consume budget). Swapping in a provider's moderation endpoint
 * means replacing this function and nothing else.
 */
export function createBasicModerator(options: { maxPromptChars?: number } = {}): Moderator {
  const maxChars = options.maxPromptChars ?? 32_000;

  return (prompt: string) => {
    if (prompt.trim().length === 0) {
      return Promise.resolve({ allowed: false, reason: 'empty prompt' });
    }
    if (prompt.length > maxChars) {
      return Promise.resolve({
        allowed: false,
        reason: `prompt exceeds ${String(maxChars)} characters`,
      });
    }
    return Promise.resolve({ allowed: true });
  };
}

export function createAllowAllModerator(): Moderator {
  return () => Promise.resolve({ allowed: true });
}
