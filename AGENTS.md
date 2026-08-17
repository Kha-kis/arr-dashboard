# AGENTS.md — arr-dashboard

Read `docs/DEVELOPMENT.md` for the tracked architecture and pattern reference. If a local
`AGENTS.local.md` exists, read it for machine-specific state and recent project
history; do not assume it exists in a fresh clone.

Keep durable contributor guidance tracked here. Personal agent definitions,
reusable workflow skills, temporary execution plans, parity ledgers, worktree
state, and maintainer-only coordination belong outside the public repository.

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
  Use a local read-only data-safety reviewer when available; the implementer
  must not be the only reviewer of the mutation boundary.
- Run a separate read-only regression review for substantial, data-dependent,
  or deletion-adjacent code changes. Do not spend subagents on trivial
  documentation-only changes.

## Layered development loop

Use the cheapest loop that can answer the current question. Do not run the
entire repository gauntlet after every edit.

1. Reproduce the defect and use RED/GREEN TDD with the narrowest test at the
   real failure boundary.
2. Run focused integration checks for the affected component, route, service,
   and nearest callers.
3. Assemble one coherent diff, then run the required independent regression
   and data-safety reviews once.
4. Resolve the recorded in-scope findings in one correction pass. Do not
   restart whole-change review for each correction; unrelated discoveries are
   follow-up work unless they prove the current change unsafe or invalid.
5. Before merge, audit every GitHub review surface: submitted reviews, inline
   comments, unresolved review threads, and the review commit versus the
   current head. Every in-scope finding must be fixed, rejected with evidence,
   or explicitly deferred as safe follow-up, and actionable threads must be
   resolved. A finding on an older commit is not obsolete until its
   applicability to the current head is checked. Wait for the configured
   GitHub Codex review result and for every PR-triggered check to finish; do not
   merge merely because the minimum branch-protection checks are green.
6. Run the full verification gauntlet once at the PR boundary and again only
   when the final diff, base, or release candidate changes materially.
7. Add live browser, disposable integration, published-image, or soak evidence
   only where it proves behavior that repository tests cannot.

## Verification gauntlet

Run the narrowest useful test while iterating. Before every PR:

```bash
pnpm run format
pnpm --filter @arr/shared build   # required when packages/shared changed
pnpm run typecheck                # root Turbo check; per-package tsc is insufficient
pnpm run test
pnpm run lint
```

Use the matching local validation workflow when available, but the commands
above remain the repository's authoritative gate.

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
