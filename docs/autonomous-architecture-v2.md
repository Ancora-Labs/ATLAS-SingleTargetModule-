# BOX Autonomous Architecture v2

## Named Roles (Holy-Name Registry)

| Layer | Role ID | Display Name | Primary Model | Responsibility |
| --- | --- | --- | --- | --- |
| Executive | `ceo-supervisor` | Janus | Claude Sonnet 4.6 | Supervises autonomy health, cost-risk decisions, user-visible escalation |
| Lead | `lead-worker` | Melchizedek | GPT-5.3-Codex | Decomposes roadmap tasks, routes work, maintains execution flow |
| Domain | `worker-backend` | Ezra | GPT-5.3-Codex | Backend reliability and service logic |
| Domain | `worker-frontend` | Mariam | GPT-5.3-Codex | Frontend stability and UI execution quality |
| Domain | `worker-api` | Elijah | GPT-5.3-Codex | API contracts and compatibility |
| Domain | `worker-integration` | Deborah | GPT-5.3-Codex | Cross-domain integration consistency |
| Verification | `worker-test` | Tabitha | GPT-5.3-Codex | Deterministic test planning and execution |
| Verification | `worker-qa` | Aquila | GPT-5.3-Codex | End-to-end and regression checks |
| Ops | `worker-devops` | Noah | GPT-5.3-Codex | CI/CD and release-path readiness |
| Ops | `worker-security` | Zachariah | GPT-5.3-Codex | Security gates and dependency-risk remediation |

## Roadmap-First Flow

1. Project scan produces framework/domain signals.
2. Roadmap engine generates repository-specific task candidates.
3. Lead worker executes tasks from roadmap candidates (not fixed template first).
4. CEO supervisor audits autonomy health and raises alerts when blocked.

## Escalation Policy

| Level | Trigger | Owner | Action |
| --- | --- | --- | --- |
| L1 Self-Heal | First failure | Assigned worker | Local retry with constrained prompt |
| L2 Lead | Repeated failure | Melchizedek | Re-route/split task and isolate cause |
| L3 CEO | Retry budget threshold | John | Strategic decision and policy guardrail |
| L4 User | Environment blocker or unresolved after threshold | John | Emit dashboard-visible alert with reason |

## Best Prompting Rules (Operational)

- Keep task prompts narrowly scoped and deterministic.
- Include explicit done criteria (build/test/security gates).
- Retry with compact recovery prompt, not full-context replay.
- Escalate to higher level only when policy requires it.
- Notify user only for actionable blockers; defer non-blocking items.

