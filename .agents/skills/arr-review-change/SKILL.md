---
name: arr-review-change
description: Review arr-dashboard branches and diffs for correctness, regressions, privacy, authorization, production data-shape failures, and mutation safety. Use for code review, merge-readiness, stabilization, trust checks, or regression audits.
---

# Review an arr-dashboard change

1. Read `AGENTS.md` and `CLAUDE.md`.
2. Resolve the actual PR base (`main` or `next`). Inspect the triple-dot branch
   diff, commits, and uncommitted changes; never assume `main`.
3. For substantial code changes, delegate a separate read-only pass to the
   `regression_reviewer` project agent. For destructive or upstream mutations,
   also delegate to `data_safety_reviewer`. Do not delegate trivial docs-only
   reviews.
4. Trace changed behavior through callers, shared contracts, API routes,
   persistence, caches, and UI consumers. Test assumptions against populated,
   paginated, multi-instance, null/fractional, and partial-failure data where
   applicable.
5. Check:
   - authorization and `userId` scoping;
   - validation, encryption, incognito masking, error redaction, and logging;
   - centralized query keys, invalidation, polling, and durable status labels;
   - route-manifest/API documentation contracts;
   - dry-run parity, fail-closed behavior, idempotency, and honest partial
     failure state for mutations;
   - regression tests at the real failure boundary.
6. Use `$arr-validate` when the user asks for readiness or when changes were
   implemented in the same task.

For review-only requests, do not implement fixes. Report concrete findings
first, ordered by severity, with file/line references and failure scenarios.
If none qualify, state that and list residual risks or validation gaps.
