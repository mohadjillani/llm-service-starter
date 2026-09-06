import pino, { type Logger } from 'pino';
import type { Config } from '../config.ts';

export type { Logger };

export function createLogger(config: Pick<Config, 'LOG_LEVEL' | 'LOG_PRETTY'>): Logger {
  return pino({
    level: config.LOG_LEVEL,
    // The API key is a credential and the prompt is user content; neither
    // belongs in a log aggregator. The key's last four characters are kept
    // because support questions start with "which key was this".
    redact: {
      paths: ['req.headers.authorization', 'req.headers["x-api-key"]', 'prompt'],
      censor: '[redacted]',
    },
    ...(config.LOG_PRETTY
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  });
}

export function keyFingerprint(apiKey: string): string {
  return apiKey.length <= 4 ? 'anonymous' : `…${apiKey.slice(-4)}`;
}
