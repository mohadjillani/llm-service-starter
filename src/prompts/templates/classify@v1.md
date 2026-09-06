---
model: gpt-4o-mini
temperature: 0
variables:
  text: string
  labels: string
---

Classify the text into exactly one of these labels: {{labels}}.

Reply with the label alone and nothing else.

Text:
{{text}}
