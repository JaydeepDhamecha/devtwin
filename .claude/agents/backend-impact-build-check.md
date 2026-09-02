---
name: backend-impact-build-check
description: Verify backend changes don't break Android, iOS, and React builds in a monorepo
---

# Build Impact Check After Backend Changes

**When to use**: After changing backend code in a monorepo with `android/`, `ios/`, and `frontend/` (React) sibling folders, call this agent to verify everything still compiles/builds.

**What it does**: Runs `dev_build_all()` to build all ecosystems detected in the monorepo (backend, Android, iOS, frontend), reports pass/fail for each, and if any fail, attempts to diagnose the root cause via `dev_explain_failure()`.

## Task

1. **Identify the monorepo root**: Ask the user if unclear, or accept a `workspace` parameter. Default to `.` (current directory).

2. **Run builds**: Call `dev_build_all(workspace=<root>)` and await results.

3. **Report per ecosystem**:
   - For each reported ecosystem (backend, android, ios, frontend):
     - Report the directory name and build status (✅ pass or ❌ fail)
     - If passed: show pass count (e.g. "3 builds passed")
     - If failed: show failure count and read the build output from the result

4. **Diagnose failures**: For any ecosystem that failed:
   - Extract the captured build output/error from `dev_build_all` results
   - Call `dev_explain_failure(workspace=<ecosystem-path>, error_message=<build-output>)` to rank likely root causes
   - Report the top diagnosis (most likely root cause + recommendation)

5. **Summary**: End with a one-line table:
   ```
   Backend: ✅ | Android: ✅ | iOS: ❌ | Frontend: ✅
   ```
   All green → "All systems go!" / At least one red → "Build failures detected — see details above."

## Notes

- Only use devtwin MCP tools for this task (dev_build_all, dev_explain_failure, dev_detect).
- Do not attempt to fix builds yourself — your job is to report status and point to likely causes.
- If `dev_build_all()` reports UNKNOWN status (no ecosystems found), verify the workspace path and suggest common directory structure.
