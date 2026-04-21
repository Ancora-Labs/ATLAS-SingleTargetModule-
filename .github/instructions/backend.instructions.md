---
applyTo: "src/**/*.js"
---

# Backend Instructions

- Keep orchestrator and worker logic deterministic and observable.
- Prefer small pure functions for policy, gating, and budget decisions.
- Make failure modes explicit in return objects and logs.
- Do not swallow errors silently.
