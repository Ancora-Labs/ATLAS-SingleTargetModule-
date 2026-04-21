# BOX TypeScript Migration Plan (3 Parca + Tek Prompt)

Net hedef: Tum repoyu kontrollu sekilde TypeScript'e gecirmek.

Net gorev sayisi: 3

Toplam token tahmini (Opus 4.6, 200k context):
- Hizli ve temiz akis: 350k - 700k
- Gercekci akis: 700k - 1.2M
- Cok bug/fix cikarsa: 1.5M+

## Kullanim sekli
1. Once Tek Prompt ile baslat (buyuk migration hamlesi).
2. Sonra 3 parcanin promptlarini sirayla uygula.
3. Her parca sonunda lint + test + typecheck kos.
4. Her parcayi ayri commit et.

---

## A) Tek Prompt (tum repoyu TS'e cevir)
Kopyala-yapistir:

```text
Migrate this entire Node.js ESM repository from JavaScript to TypeScript incrementally but aggressively.

Primary objective:
- Convert the whole repo to TypeScript with minimal behavior change.

Hard constraints:
1) Preserve runtime behavior.
2) Keep ESM compatibility.
3) Do not introduce broad architecture refactors.
4) JS+TS may coexist temporarily only if needed for passing checks.
5) Prefer explicit types over implicit any.

Required implementation:
1) Add/adjust TypeScript toolchain (tsconfig, scripts, typings).
2) Migrate source files in src/ (core, providers, workers, dashboard, config/cli).
3) Update tests for TS compatibility.
4) Fix import paths/extensions for ESM correctness.
5) Keep lint, test, and typecheck green.

Required output:
- Files changed (grouped by area)
- Commands executed
- Remaining type debt (if any)
- Risk notes
```

---

## B) 3'e Bolunmus Hali

### Parca 1/3 - Altyapi + Core
Kapsam:
- TS altyapisi
- src/core
- src/types (ortak tipler)

Token hedefi:
- 180k - 320k

Kopyala-yapistir:

```text
TypeScript Migration - Part 1/3 (Infrastructure + Core)

Scope:
- TypeScript toolchain setup
- src/core migration
- shared type layer under src/types

Requirements:
1) Keep behavior unchanged.
2) Preserve Node ESM runtime compatibility.
3) Use explicit function return types in critical orchestration/governance flows.
4) Avoid large refactors unrelated to migration.

Validation target:
- lint passes
- tests pass (or list exact failing tests with reasons)
- typecheck passes for migrated scope

Output:
- changed files list
- unresolved issues list
- exact next-step prompt for Part 2
```

Basari kriteri:
- Core akislari TS'e alinmis
- Altyapi stabil

---

### Parca 2/3 - Providers + Workers + Entrypoints
Kapsam:
- src/providers
- src/workers
- src/cli.js ve src/config.js (TS'e gecis)

Token hedefi:
- 160k - 300k

Kopyala-yapistir:

```text
TypeScript Migration - Part 2/3 (Providers + Workers + Entrypoints)

Scope:
- src/providers
- src/workers
- entry/config files

Requirements:
1) Model external API boundaries safely (narrow unknown values).
2) Keep worker runtime behavior unchanged.
3) Keep CLI startup path unchanged.
4) Keep ESM import correctness.

Validation target:
- lint passes
- tests pass (or precise failure list)
- typecheck passes for migrated scope

Output:
- changed files grouped by providers/workers/entrypoints
- temporary any/unknown debt list
- exact next-step prompt for Part 3
```

Basari kriteri:
- Runtime giris ve worker akisi bozulmamis
- Provider tip sinirlari netlesmis

---

### Parca 3/3 - Dashboard + Tests + Strict Hardening
Kapsam:
- src/dashboard
- tests/
- strict ayarlar ve son temizlik

Token hedefi:
- 160k - 320k

Kopyala-yapistir:

```text
TypeScript Migration - Part 3/3 (Dashboard + Tests + Strictness)

Scope:
- src/dashboard
- tests
- strict TypeScript hardening

Requirements:
1) Migrate remaining dashboard/test files to TS compatibility.
2) Increase strictness safely (noImplicitAny, strictNullChecks where feasible).
3) Make typecheck mandatory in CI if not already.
4) Remove avoidable compatibility shims.

Validation target:
- lint green
- test green
- typecheck green

Final output format:
- final checklist
- residual JS files (if any)
- residual type debt (if any)
- recommended follow-up tasks
```

Basari kriteri:
- Repo genelinde TS gecisi kapanisa gelmis
- CI kapilari net

---

## Her parca sonunda sabit komutlar

```bash
npm run lint
npm test
npm run typecheck
```

## Commit formati (onerilen)
- chore(ts): setup toolchain and shared types
- refactor(ts): migrate core/providers/workers to typescript
- test(ts): migrate tests and enable stricter type gates
