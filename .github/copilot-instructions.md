# BOX Copilot Instructions

## Project intent

- This repository hosts the BOX orchestrator and worker runtime for autonomous software delivery.
- Keep solutions production-oriented, minimal, and reversible.

## Coding rules

- Use modern Node.js (ESM) and avoid unnecessary dependencies.
- Keep changes scoped to the requested task.
- Avoid overengineering and avoid broad refactors unless requested.

## Quality requirements

- Build must pass.
- Tests must pass.
- Changes should preserve existing conventions.
- If any assumption is uncertain, leave a concise note in code comments.

## Safety rules

- Never suggest force pushing or destructive git operations.
- Never hardcode secrets or tokens.
- Prefer deterministic behavior over speculative changes.
