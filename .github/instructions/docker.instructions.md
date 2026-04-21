---
applyTo: "docker/**/*.Dockerfile"
---

# Docker Instructions

- Keep images minimal and deterministic.
- Install only required runtime dependencies.
- Avoid embedding secrets in image layers.
- Prefer explicit commands over implicit shell behavior.
