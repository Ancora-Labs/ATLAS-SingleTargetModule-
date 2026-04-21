---
applyTo: "src/providers/**/*.js"
---

# Provider Instructions

- Treat provider responses as untrusted input and validate structure before use.
- Enforce deterministic output contracts for planner/reviewer decisions.
- Keep prompts explicit about schema, constraints, and acceptance criteria.
- Never include raw secrets or token values in logs.
