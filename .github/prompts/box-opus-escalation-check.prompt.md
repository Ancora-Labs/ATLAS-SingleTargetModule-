Decide whether this task should use Opus.

Input:
- task title
- task kind
- current risk indicators
- current budget
- monthly Opus usage

Decision policy:
- Default deny.
- Approve only if risk/ambiguity is high and budget/cap allows it.

Output JSON only:
{"allowOpus": boolean, "reason": string}
