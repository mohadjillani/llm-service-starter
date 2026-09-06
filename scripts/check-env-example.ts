import { readFile } from 'node:fs/promises';
import { configKeys } from '../src/config.ts';

/**
 * Fails when .env.example and the configuration schema disagree.
 *
 * A stale example file is worse than none: it is the first thing someone copies
 * and the last thing anyone updates, and a key missing from it turns into a
 * startup failure on somebody else's machine.
 */
async function main(): Promise<number> {
  const content = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  const documented = new Set(
    content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => line.split('=')[0]?.trim() ?? ''),
  );

  const expected = new Set(configKeys());
  const missing = [...expected].filter((key) => !documented.has(key));
  const extra = [...documented].filter((key) => !expected.has(key));

  if (missing.length === 0 && extra.length === 0) {
    console.log(`.env.example documents all ${String(expected.size)} configuration keys`);
    return 0;
  }

  if (missing.length > 0) console.error(`missing from .env.example: ${missing.join(', ')}`);
  if (extra.length > 0) console.error(`not in the schema: ${extra.join(', ')}`);
  return 1;
}

process.exitCode = await main();
