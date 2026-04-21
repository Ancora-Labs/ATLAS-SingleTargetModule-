# ATLAS(SingleTargetModule)

ATLAS(SingleTargetModule) is the public single-target autonomous software delivery runtime extracted from BOX.

This repository is being shaped as a clean product surface:

- single-target onboarding and delivery
- planning, execution, verification, and readiness flow
- public-facing operator branding
- no self-development runtime
- no internal BOX repair or self-improvement loop

The public supervisor identity is Janus.

## Current Status

The repository scaffold is in place and the first runtime modules are being migrated in controlled slices.
Until migration is complete, Atlas is intentionally smaller than BOX and excludes internal-only behavior.

## Principles

- Keep only product-facing single-target functionality.
- Port mixed runtime code only after self-dev behavior is removed.
- Prefer minimal reversible changes over broad copies.
