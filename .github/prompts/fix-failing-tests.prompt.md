Fix the failing tests in this repository.

Context:
- Use failing output and related source files before editing.
- Prefer fixing production code when tests expose real defects.

Constraints:
- Do not bypass tests.
- Do not disable assertions or skip suites to get green status.
- Do not hardcode values that only satisfy current test inputs.
- Keep fix minimal and aligned with project behavior.

Acceptance criteria:
- Root cause is identified and stated.
- Failing tests pass after fix.
- No unrelated tests regress.

Output format:
- `Root cause:` one paragraph.
- `Fix:` changed files and key logic updates.
- `Validation:` test commands run and result.
- `Follow-up:` optional one-line hardening suggestion.
