# Autonomous Execution Directives

## Strictly Enforced Rules for Claude CLI / Goal Mode
1. **Never Stop for User Decisions**: When executing tasks or running in `/goal` mode, NEVER stop to ask the user for confirmation, choices, or permissions (e.g. asking whether to commit untracked files, asking which path to choose, or asking for input).
2. **Make Autonomous Best Choices**: Always pick the safest, most efficient, and reasonable option autonomously (e.g. proceed with the working tree as-is, auto-create non-destructive git commits if needed, auto-resolve layout decisions) and CONTINUE execution immediately.
3. **Continuous Execution**: Keep executing step-by-step without stopping until the task is completely finished.
