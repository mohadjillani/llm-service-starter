import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export interface PromptTemplate {
  /** Base name without the version, e.g. `summarize`. */
  name: string;
  version: number;
  /** `summarize@v2` — what a request asks for. */
  id: string;
  model?: string | undefined;
  temperature?: number | undefined;
  variables: Record<string, 'string' | 'number' | 'boolean'>;
  body: string;
}

export type RenderResult = { ok: true; prompt: string } | { ok: false; error: string };

const frontmatter = z.object({
  model: z.string().optional(),
  temperature: z.number().optional(),
  variables: z.record(z.string(), z.enum(['string', 'number', 'boolean'])).default({}),
});

const FILENAME = /^(?<name>[a-z0-9-]+)@v(?<version>\d+)\.md$/;

export function parseTemplate(filename: string, content: string): PromptTemplate {
  const match = FILENAME.exec(filename);
  if (!match?.groups) {
    throw new Error(`template filename must look like name@vN.md, got "${filename}"`);
  }

  const parts = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(content);
  if (!parts) throw new Error(`template ${filename} is missing its frontmatter block`);

  const meta = frontmatter.parse(parseYaml(parts[1] ?? ''));
  const name = match.groups.name ?? '';
  const version = Number(match.groups.version ?? '0');

  return {
    name,
    version,
    id: `${name}@v${String(version)}`,
    model: meta.model,
    temperature: meta.temperature,
    variables: meta.variables,
    body: (parts[2] ?? '').trim(),
  };
}

function schemaFor(template: PromptTemplate): z.ZodType {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, kind] of Object.entries(template.variables)) {
    shape[key] = kind === 'number' ? z.number() : kind === 'boolean' ? z.boolean() : z.string();
  }
  // strict() so a typo in a variable name is an error rather than a silently
  // ignored key and a prompt with an unfilled placeholder.
  return z.object(shape).strict();
}

export interface PromptRegistry {
  list(): { id: string; variables: string[]; model?: string | undefined }[];
  get(id: string): PromptTemplate | undefined;
  render(id: string, variables: Record<string, unknown>): RenderResult;
}

/**
 * Templates are files with a version in the name, and requests name the version
 * they want.
 *
 * A prompt is an input to the model in the same way code is an input to a
 * compiler: changing it changes the output, and a change that improves one case
 * usually degrades another. Editing a prompt in place makes that invisible —
 * yesterday's outputs become unreproducible and there is nothing to compare
 * against. A new version is a new file, both stay loadable, and `npm run eval`
 * scores them against the same cases.
 */
export function createPromptRegistry(directory?: string): PromptRegistry {
  const dir = directory ?? fileURLToPath(new URL('templates', import.meta.url));
  const templates = new Map<string, PromptTemplate>();

  for (const filename of readdirSync(dir).filter((file) => file.endsWith('.md'))) {
    const template = parseTemplate(filename, readFileSync(path.join(dir, filename), 'utf8'));
    templates.set(template.id, template);
  }

  return {
    list() {
      return [...templates.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((template) => ({
          id: template.id,
          variables: Object.keys(template.variables),
          model: template.model,
        }));
    },

    get(id) {
      return templates.get(id);
    },

    render(id, variables) {
      const template = templates.get(id);
      if (!template) {
        return {
          ok: false,
          error: `no template "${id}" — known: ${[...templates.keys()].join(', ')}`,
        };
      }

      const parsed = schemaFor(template).safeParse(variables);
      if (!parsed.success) {
        return {
          ok: false,
          error: parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; '),
        };
      }

      const values = parsed.data as Record<string, unknown>;
      let prompt = template.body;
      for (const [key, value] of Object.entries(values)) {
        prompt = prompt.replaceAll(`{{${key}}}`, String(value));
      }

      const leftover = /\{\{(\w+)\}\}/.exec(prompt);
      if (leftover) {
        return {
          ok: false,
          error: `template ${id} references {{${leftover[1] ?? ''}}} but does not declare it`,
        };
      }

      return { ok: true, prompt };
    },
  };
}
