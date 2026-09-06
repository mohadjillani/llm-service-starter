---
model: gpt-4o-mini
temperature: 0
variables:
  text: string
  max_words: number
---

Summarise the following text in at most {{max_words}} words.

{{text}}
