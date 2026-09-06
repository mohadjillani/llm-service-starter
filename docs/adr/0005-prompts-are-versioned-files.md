# ADR 0005: Prompts are versioned files, and requests name the version

**Status:** accepted · **Date:** 2026-09-06

## Context

A prompt is an input that determines the output, the same way source code is.
Changing one changes what the service produces, and a change that improves one
kind of input usually degrades another.

The default is a template literal somewhere in the request handler. Editing it
is a one-line diff with no obvious blast radius, which is exactly the problem: a
week later nobody can reproduce last week's outputs, and there is nothing to
compare a proposed change against.

## Decision

Templates live in `src/prompts/templates/<name>@v<N>.md` with a YAML frontmatter
block declaring the model, temperature and variables. Every version stays on
disk, and a request names the one it wants — `summarize@v2`.

Variables are validated against a schema built from the frontmatter, in strict
mode, so a typo in a variable name is a 400 rather than a prompt sent with an
unfilled `{{placeholder}}` in it. A leftover placeholder after rendering is also
an error: a template that references a variable it does not declare fails
loudly.

## Consequences

Two versions of a prompt can serve traffic simultaneously, which is what makes a
gradual rollout or an A/B comparison possible at all. `npm run eval` renders
every version against the same golden cases, and its committed report is checked
in CI, so changing a template without regenerating it fails the build.

The report measures what each version costs to send rather than how good its
answers are — that is a deliberate limit, discussed in the report itself. The v2
instruction block is 65% more expensive per call than v1, which is the kind of
fact that stays invisible when prompts live in string literals.

The cost of the decision is indirection: reading the code no longer shows the
prompt. `GET /v1/prompts` lists what is loaded, and the files are plain Markdown,
which is a reasonable trade for being able to answer "what exactly did we send
last Tuesday".
