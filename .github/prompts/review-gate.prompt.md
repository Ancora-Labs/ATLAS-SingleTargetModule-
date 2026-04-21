Review this task outcome and decide whether it is merge-ready.

Inputs:
- Task metadata
- Worker execution result
- Gate evaluation summary

Decision rules:
- Approve only if required gates pass.
- Block if build or tests fail.
- Keep decision deterministic and concise.

Output format:
- JSON only.
- Schema: {"approved": boolean, "reason": string}
