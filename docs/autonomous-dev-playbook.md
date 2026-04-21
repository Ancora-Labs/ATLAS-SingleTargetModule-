# Autonomous Dev Playbook (Claude Supervisor + Copilot Workers)

## 1. Sistem Amaci

Bu sistem, BOX orchestrator uzerinde 7/24 otonom yazilim gelistirme dongusu calistirir.
Rol ayrimi katidir:

- Claude: Team Lead / Supervisor (kod yazmaz)
- Copilot: Planner + Developer + Reviewer workerlari (kodu uretir ve test eder)
- BOX: Kuyruk, worker orkestrasyonu, gate, state ve budget yonetimi

## 2. Degismez Kural

`Claude kod yazmaz. Claude sistemi yonetir.`

Bu kural pratikte su anlama gelir:

- Claude sadece planlama, risk degerlendirme, review karari, escalation kararinda kullanilir.
- Worker container icinde kod uretimi sadece Copilot runtime ile yapilir.
- Coder model secimi Claude supervisor-only modunda GPT-Codex hattina sabitlenir.

## 3. Katmanlar

1. Orchestration Layer: `src/core/orchestrator.ts`
2. Intelligence Layer: `src/core/prometheus.ts`, `src/core/athena_reviewer.ts`
3. Worker Layer: `src/core/worker_runner.ts`, `src/core/evolution_executor.ts`
4. State Layer: `state/*.json`, `src/core/state_tracker.ts`
5. Policy/Budget Layer: `src/core/learning_policy_compiler.ts`, `src/core/budget_controller.ts`

## 4. 7/24 Otonom Dongu

1. Project scan
2. Task generation
3. Queue dispatch
4. Worker coding + build + test
5. Deterministic gates
6. Claude supervisor review
7. PR/Merge policy uygulamasi
8. State update ve tekrar

## 5. Prompt Tasarim Prensipleri

- Her prompt acik rol tanimi ile baslar.
- Cikti semasi zorunlu tutulur (JSON schema).
- Gorevler kucuk ve bagimsiz parcaya bolunur.
- Token optimizasyonu icin sadece gerekli baglam verilir.
- Acceptance criteria net ve test edilebilir yazilir.

## 6. Claude Team Lead System Prompt (Template)

Use this in reviewer/planning channels:

```text
You are the TEAM LEADER AI of an autonomous software development system.

Responsibilities:
- monitor project status
- generate small independent tasks
- supervise worker progress
- make merge risk decisions

Hard rules:
1) NEVER write code
2) NEVER do full repository deep dives
3) ONLY return structured planning/review decisions
4) Optimize for low token usage
5) Escalate only when risk or blocker is high

Return strict JSON only.
```

## 7. Copilot Worker Prompt (Template)

Use this in worker runtime:

```text
You are a senior software engineer operating inside BOX worker runtime.

Task:
{{TASK_TITLE}}
Kind:
{{TASK_KIND}}

Rules:
- Implement only the requested scope.
- Keep diff minimal and production-safe.
- Run build and tests, then report clear pass/fail markers.
- Do not modify unrelated files.

Output:
Working code changes + deterministic status markers.
```

## 8. Task JSON Sozlesmesi

```json
{
  "task_id": "feature_auth_1",
  "type": "feature",
  "description": "Add JWT authentication",
  "files": ["/app/api/auth", "/lib/jwt"],
  "expected_output": "JWT login system",
  "priority": "high"
}
```

## 9. Budget Guardrails

- Claude sadece planning/review/escalation icin cagrilir.
- Coder tarafinda pahali model otomatik escalations kapali tutulur.
- Gunluk/aylik cagrilar state dosyalarinda izlenir.

## 10. Operasyon Checklist

- `runtime.claudeSupervisorOnly=true`
- `copilot.allowedModels` coder-safe liste
- `gates` aktif ve deterministic
- Worker basarisizliklarinda issue handoff
- Dashboard uzerinden queue ve worker health takibi

## 11. Gelistirme Sirasi (Senior Uygulama Plani)

1. Role policy sertlestirme (tamamlandi: supervisor-only config)
2. Task schema normalizasyonu ve validator ekleme
3. Worker tiplerine gore routing genisletme (coder/tester/debug/refactor/docs)
4. Retry + split stratejisinde risk tabanli iyilestirme
5. Cost dashboard ve call-throttle metriklerini sikilastirma
6. Merge policy ve protected path kontrollerini sertlestirme
7. End-to-end regression test senaryolari

## 12. Drift Debt Onceliklendirme (Ghost-Path Koruma)

- `docs/autonomous-dev-playbook.md` icindeki stale referanslar, planner tarafinda yuksek drift-debt onceligi alir.
- Bu dosyada stale path birikmesi, ghost-path planning riskini artirdigi icin orchestrator pre-dispatch gate tarafinda bloklayici sinifta ele alinabilir.
- Drift debt gorevleri deterministic olarak `tests/core/architecture_drift.test.ts` hedefleri ile uretilir ve kapanis bu test kaniti ile dogrulanir.
