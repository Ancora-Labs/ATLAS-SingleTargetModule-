# Single-Target Startup Requirements

BOX fails closed before single-target startup when the required GitHub credentials are missing.

Required environment variables:

- `GITHUB_TOKEN`: Used for target repository GitHub API operations and repository-scoped automation.
- `COPILOT_GITHUB_TOKEN`: Used for Copilot-powered target delivery and agent execution. Legacy aliases such as `GITHUB_FINEGRADED` are still accepted through config normalization.

Why BOX blocks startup:

- Single-target delivery needs GitHub API access for repository preparation, PR flow, and target repo automation.
- Single-target delivery also needs a Copilot-capable GitHub token for worker execution.
- BOX must not continue in a half-configured state that would fail later during onboarding or execution.

Secret boundary:

- BOX does not auto-create or auto-fetch GitHub tokens.
- BOX does not auto-create or auto-fetch external service secrets such as MongoDB credentials, API keys, billing-backed SaaS tokens, or deployment credentials.
- Those values must be provided by the user or by an approved secrets system already available in the environment.