---
model: gpt-4o-mini
temperature: 0
variables:
  text: string
  max_words: number
---

Summarise the text below in at most {{max_words}} words.

Rules:

- Lead with the single most important fact.
- Keep concrete numbers, names and dates; drop adjectives.
- Write plain sentences, no preamble and no closing summary line.

Text:
{{text}}
