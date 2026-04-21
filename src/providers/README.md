# Provider Contracts

BOX supports pluggable providers:

- `coder`: produces code changes for a task.
- `reviewer`: approves or blocks task completion.

Current implementations:

- `coder/copilot_cli_provider.js`
- `coder/fallback_provider.js`
- `reviewer/claude_reviewer.js`

Copilot coder behavior:

- Uses a single `task-best` strategy for model selection.
- Enforces allowlist, never-use list, and multiplier guardrails.
- Allows Opus escalation only under explicit escalation conditions.
- Falls back to auto invocation if selected manual model invocation is rejected.

Future providers can implement the same surface and be selected by config.
