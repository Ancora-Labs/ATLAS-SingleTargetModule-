# Atlas Public Migration Plan

## What I Understand

Yes, I understand the goal.

`Atlas` is not meant to be a mirror of BOX.

It will be:

- the first clean public open-source release
- only the fresh single-target product surface
- no weird internal BOX leftovers
- no self-improvement stack
- no self-dev operational clutter
- renamed product-facing supervisor identity: `Janus` -> `Janus`

That means we should not think "move all contents" literally.

We should think:

- take the working system
- remove private/internal evolution behavior
- rename product-facing concepts
- ship only the clean runtime users should see

## Public Product Rule

Atlas should contain only what a public user needs to run the system.

That means:

- target intake
- single-target session lifecycle
- planning and execution loop
- worker dispatch and verification
- readiness and completion logic
- CLI and maybe dashboard

Atlas should not contain:

- BOX self-improvement
- BOX self-dev exit policy
- BOX internal adaptation metrics
- BOX internal tuning or repair machinery
- internal names and concepts that make the product feel like a private lab system

## Naming Rule

In Atlas:

- `Janus` becomes `Janus`

This rename should happen in the Atlas product surface, not necessarily inside BOX right now.

Why:

- BOX can stay the internal upstream
- Atlas can have a clean public-facing naming model
- we avoid mixing public product branding with internal runtime naming while extraction is still in progress

## The Most Important Architectural Decision

BOX and Atlas should be treated as:

- `BOX` = internal upstream
- `Atlas` = curated public downstream

For now, Atlas is not the main development repo.

For now, BOX stays the place where you continue self-dev and experimental improvement.

Atlas receives selected, cleaned, product-safe changes.

That keeps the public repo stable and keeps private experimentation free.

## How Future Updates Should Work

You asked the critical question:

If BOX improves later in self-dev mode, how do we pass those improvements into Atlas?

### Short answer

Not by merging BOX wholesale.

Instead:

1. Improve BOX internally.
2. Decide whether a change is product-safe for Atlas.
3. Re-apply or extract only the relevant product-facing diff.
4. Keep Atlas clean even if BOX remains more complex.

### Right now, before modular cleanup exists

Because the system is still mixed, the safe process is:

1. Change lands in BOX.
2. We classify it:
   - public product improvement
   - BOX-only improvement
   - mixed improvement
3. If public product improvement, we port it to Atlas.
4. If mixed, we split first, then port only the Atlas half.
5. If BOX-only, it never goes to Atlas.

### Later, after core/module cleanup exists

Later the clean model should be:

- shared `core`
- Atlas product modules
- BOX internal modules

At that point syncing gets much easier because more changes can move as module-level updates instead of manual surgery.

But for now, the right move is curated extraction, not automatic sync.

## Recommended Sync Policy

For the near term, use this rule:

### Changes that should flow to Atlas

- single-target correctness fixes
- target session stability fixes
- worker execution correctness
- verification correctness
- CLI usability improvements relevant to public users
- dashboard improvements relevant to public users
- planning quality improvements that do not depend on self-dev internals

### Changes that should stay in BOX

- self-improvement logic
- self-dev-only metrics and policies
- internal experiment systems
- adaptation or tuning that exists only to improve BOX itself
- internal recovery and repair machinery for BOX evolution

### Changes that need split first

- orchestrator changes that mix target delivery and self-improvement
- prompt changes that mix single-target and self-dev assumptions
- mode-state changes that still assume `self_dev` is a public runtime mode

## Practical Transfer Model For Now

Because the Atlas repo is public and should stay clean, the process should be:

1. Prepare Atlas extraction in BOX docs and matrix files.
2. Clone the empty Atlas repo locally.
3. Copy only the approved Atlas runtime files.
4. Rename public-facing product identities like `Janus` -> `Janus` in Atlas.
5. Run typecheck and startup in Atlas.
6. Fix imports and trim leftovers until Atlas boots cleanly.

This is cleaner than trying to push a raw BOX snapshot into a public repository.

## What We Should Do Next

The next concrete step is not "move everything".

The next concrete step is:

1. Define the Atlas public file set.
2. Define public renames.
3. Define the first copy order.
4. Clone the Atlas repo locally.
5. Start the extraction with the smallest bootable slice.

## Public Renames To Plan

First rename set for Atlas:

- `Janus` -> `Janus`
- `BOX` -> `Atlas` where it appears in user-facing text, CLI output, dashboard labels, and docs

Do not blindly rename every internal symbol first.

Preferred order:

1. rename user-facing strings
2. rename product-facing role labels
3. rename internal symbols only when Atlas compiles and boots safely

## Current Recommendation

Do not attempt one-shot migration of the entire repository into Atlas.

Do a controlled public extraction with:

- clean runtime
- clean branding
- no self-improvement
- no self-dev mode
- no private experimental baggage

That gives you a stable public OSS product now, while keeping future BOX -> Atlas updates manageable through curated porting.
