# AGENTS.md — arr-dashboard

Read `CLAUDE.md` for the tracked architecture and pattern reference. If a local
`HANDOVER.md` exists, read it for machine-specific state and recent project
history; do not assume it exists in a fresh clone.

Codex-native task workflows live in `.agents/skills/` and are automatically
discoverable. Use the matching `arr-*` skill for issue fixes, validation,
reviews, integration changes, PR preparation, and releases. Project reviewers
live in `.codex/agents/`. `.claude/` files are compatibility material, not the
canonical Codex workflow.

## Branch and issue discipline

- `main` is stable 2.x maintenance. Limit it to security fixes, data-safety
  fixes, regressions, and explicitly approved maintenance.
- `next` is 3.0 development and stabilization. New 3.0 work targets `next`.
- Fetch the intended base and create a task branch before editing. Do not add
  work to an unrelated branch merely because it is currently checked out.
- For a bug affecting both lines, reproduce on both. Fix `main` first when
  stable users are affected, then forward-port with a separate `next` change;
  do not merge the branches wholesale.
- Squash-merge PRs. Keep each PR focused on one coherent concern.
- Never `@`-mention anyone in PR or issue text. The owner is `Kha-kis`;
  `khak1s` is an unrelated GitHub user. Attribute with backticks or prose.
- Use a standalone `Closes #N` PR-body line only after reproducing the
  reporter's actual scenario and verifying the fix against it. Otherwise use
  `Related to #N`. Sanitize commit messages as an independent auto-close
  surface.

## Safety-critical mutations

Deletion, file removal, unmonitoring, queue cleanup, restore, schema change,
TRaSH deployment, and upstream write paths are safety-critical.

- Dry-run and preview modes must not mutate the database, filesystem, or an
  upstream service. Previewed targets and actions must be the same targets and
  actions used by real execution.
- Fail closed when ownership, service identity, shared-library correlation,
  file identity, upstream state, or a safety dependency cannot be established.
  A failed safety check never becomes permission to mutate.
- Resolve and authorize every target at execution time. Never trust a cached
  preview, client-supplied owner, title, path, or instance identifier as final
  authority.
- Treat multiple service instances pointing at the same media library as a
  normal production scenario. Test cross-instance and same-title collisions.
- Record success only after the upstream mutation succeeds. On partial
  failure, preserve an honest retryable state and an actionable audit trail;
  never claim completion from a cache-only update.
- Cover success, expected failure, dependency failure, dry-run, real mutation,
  partial completion, retry/idempotency, and concurrent invocation as
  applicable.
- Run an independent data-safety review before merging deletion-adjacent work.
  Delegate it to the read-only `data_safety_reviewer` project agent; the
  implementer must not be the only reviewer of the mutation boundary.
- Delegate a separate `regression_reviewer` pass for substantial,
  data-dependent, or deletion-adjacent code changes. Do not spend subagents on
  trivial documentation-only changes.

## Review convergence

For substantial or safety-critical gauntlets, freeze the acceptance contract
before full review, give each required critic one discovery pass, and record
actionable findings in a stable ledger. After discovery closes, review only
unresolved findings, their remediation delta, and directly affected mutation
paths; do not restart an unrestricted whole-feature audit after every fix.

- P0 and P1 findings always block. P2 findings block when they violate the
  frozen contract or were introduced by the current delta. Record unrelated or
  pre-existing hardening as a follow-up with maintainer rationale.
- Request one full hosted pull-request review on the frozen candidate and
  address accepted findings in one remediation batch. Request another full
  hosted review only when that remediation materially changes the architecture
  or a safety-critical mutation boundary; otherwise use targeted closure review
  and CI. A third full review requires a newly scoped gauntlet wave rather than
  another expansion of the current pull request.
- A review budget limits repeated re-auditing. It never permits merging with a
  known unresolved blocker.

Library Cleanup uses the detailed discovery, closure, and exit gates in
`docs/library-cleanup-gauntlet.md`.

## Verification gauntlet

Run the narrowest useful test while iterating. Before every PR:

```bash
pnpm run format
pnpm --filter @arr/shared build   # required when packages/shared changed
pnpm run typecheck                # root Turbo check; per-package tsc is insufficient
pnpm run test
pnpm run lint
```

Use `$arr-validate` to apply and report this gauntlet consistently.

Run `pnpm run build` for release-sensitive, dependency, Docker, routing, or
substantial frontend changes. Live-verify user-visible behavior in a real
browser. Use populated fixtures for data-dependent behavior; an empty
development database is not sufficient evidence.

## Code invariants

1. Frontend calls `/api/*` through Next rewrites, never `localhost:3001`.
2. Include `userId: request.currentUser!.id` in every Prisma query for
   user-owned resources.
3. Encrypt API keys with `app.encryptor.encrypt()` and store both value and IV.
4. Parse request bodies with `validateRequest()`; never cast
   `request.body as Type`.
5. Sensitive titles, usernames, URLs, and instance names require incognito
   helpers; component tests require `<IncognitoProvider>`.
6. Use centralized query keys and polling constants; invalidate after
   mutations.
7. Use semantic/brand/theme colors and semantic z-index classes.
8. Radarr/Sonarr updates fetch the full resource with `getById()` and spread it
   into the PUT payload.
9. A new route group requires a route-manifest entry and
   `docs/API-ROUTES.md`; a new Pulse collector requires `COLLECTOR_LABELS` and
   a stable entity-keyed signal id.
10. Use `getErrorMessage()` and pino (`request.log`/`app.log`), never production
    `console.log`.

## Definition of done

- The reported scenario is represented by a regression test where practical.
- Focused tests and the repository gauntlet pass; failures are reported
  honestly rather than bypassed.
- User-visible behavior is live-verified and documented when needed.
- No secrets, generated artifacts, placeholders, commented-out
  implementations, or unrelated cleanup enter the diff.
- The final handoff states behavior changed, files affected, risks, validation,
  and any required forward-port or release action.
