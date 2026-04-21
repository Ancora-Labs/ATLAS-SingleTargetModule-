Implement the following task in this repository.

Task: {{TASK_TITLE}}

Context:
- Use the currently open workspace as the source of truth.
- Follow existing coding patterns and naming conventions.

Examples:
- If task is "add health endpoint", create only endpoint + tests + wiring, not a broad refactor.
- If task is "rename config field", update all direct references and related tests in one coherent diff.

Constraints:
- Keep changes minimal and focused.
- Do not introduce unrelated refactors.
- Preserve behavior unless task explicitly requests behavior change.
- Never hardcode secrets, tokens, or environment-specific values.

Acceptance criteria:
- Implementation satisfies task scope.
- Build passes.
- Tests pass.
- Changed files are directly relevant to the task.

Output format:
- `Plan:` 2-4 short steps.
- `Changes:` list updated files and why.
- `Validation:` commands run and pass/fail.
- `Risks:` any remaining concern in one short paragraph.
