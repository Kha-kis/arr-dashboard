# Tautulli Preservation and Migration Reversal Plan

> **Required subskill:** Use `superpowers:subagent-driven-development` to execute this plan task by task. Use `arr-validate` before PR preparation.

**Goal:** Remove the destructive 3.0 Tautulli-removal flow and replace it with durable, non-blocking notices that preserve existing integrations and rules.

**Architecture:** Startup becomes observation-only. Historical migration reports remain audit evidence, while a user-scoped dismissal record controls one-time notices. The API reports only product state; the web app renders a dismissible settings notice and never blocks navigation.

**Tech stack:** Fastify, Prisma/PostgreSQL, Zod, React, TanStack Query, Vitest, Testing Library.

**Global constraints:** Target `next`; never delete Tautulli configuration or rules; never reconstruct credentials from reports; preserve ADR history; use one coherent implementation review and one correction batch.

---

## Task 1: Supersede the removal decision

**Files:**
- Create: `docs/adr/0009-tracearr-primary-tautulli-alternative.md`
- Modify: `docs/adr/0007-tracearr-replaces-tautulli.md`
- Modify: `CLAUDE.md`
- Modify: `docs/3.0-charter.md`
- Modify: `docs/superpowers/plans/2026-08-11-next-maintenance-parity-program.md`

- [ ] Write ADR-0009 with Tracearr recommended, Tautulli supported, deterministic selection, no mixing, no failover, and identity-gated cleanup evidence.
- [ ] Mark ADR-0007 `Superseded by ADR-0009`; retain its original rationale as history.
- [ ] Replace temporary removal/wizard language in the architecture reference, charter, and program plan with the approved four-state behavior.
- [ ] Search for stale mandates: `rg -n "remove Tautulli|Tautulli removal|blocking migration|migration wizard" CLAUDE.md docs`.
- [ ] Commit: `docs: supersede tautulli removal decision`.

## Task 2: Prove startup does not remove Tautulli state

**Files:**
- Modify: `apps/api/src/bootstrap/infrastructure.ts`
- Delete or reduce to report-only: `apps/api/src/plugins/tautulli-migration.ts`
- Modify: `apps/api/src/lib/rules-migration/tautulli-pass.ts`
- Test: `apps/api/src/plugins/__tests__/tautulli-migration.test.ts`
- Test: `apps/api/src/lib/rules-migration/__tests__/tautulli-pass.test.ts`

- [ ] Add a failing startup test with a Tautulli service and Tautulli-backed rule asserting both rows survive infrastructure startup unchanged.
- [ ] Run `pnpm --filter @arr/api test -- tautulli-migration tautulli-pass` and confirm the test fails for the existing mutation path.
- [ ] Remove automatic registration/execution of the destructive pass. Keep the report reader pure and observation-only.
- [ ] Add an assertion that startup does not create acknowledgements or change report content.
- [ ] Re-run the focused tests and commit: `fix: preserve tautulli state during startup`.

## Task 3: Add durable notice dismissal state and API

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260812090000_add_system_notice_dismissal/migration.sql`
- Modify: `apps/api/src/routes/system.ts`
- Modify: `apps/api/src/routes/__tests__/system-migrations-tautulli.test.ts`
- Modify: `apps/api/src/routes/route-manifest.ts`
- Modify: `docs/API-ROUTES.md`

- [ ] Add `SystemNoticeDismissal { id, userId, noticeKey, dismissedAt }`, a `User` relation, and `@@unique([userId, noticeKey])`.
- [ ] Add failing API matrix tests for: neither provider, Tautulli only, Tracearr only, both, proven prior removal, dismissed notice, and cross-user isolation.
- [ ] Define response types:

```ts
type TautulliNoticeKind = "both-configured" | "prior-removal";
type TautulliNotice = {
  key: string;
  kind: TautulliNoticeKind;
  actionUrl: "/settings/services";
};
```

- [ ] Replace the deletion acknowledgement endpoint with a validated dismissal endpoint that only upserts the current user's notice key.
- [ ] Emit `prior-removal` only when the existing report proves the prior beta removed state; never expose credentials or raw report secrets.
- [ ] Run `pnpm --filter @arr/api test -- system-migrations-tautulli` and commit: `feat: expose nonblocking tautulli notices`.

## Task 4: Replace the blocking wizard with a notice

**Files:**
- Modify: `apps/web/src/lib/api-client/system.ts`
- Modify: `apps/web/src/hooks/api/useSystem.ts`
- Modify: `apps/web/src/lib/query-keys.ts`
- Delete: `apps/web/src/features/migrations/components/tautulli-migration-dialog.tsx`
- Create: `apps/web/src/features/migrations/components/tautulli-provider-notice.tsx`
- Modify: `apps/web/src/components/layout/layout-wrapper.tsx`
- Test: `apps/web/src/features/migrations/components/__tests__/tautulli-provider-notice.test.tsx`
- Test: `apps/web/src/hooks/api/__tests__/useSystem.test.tsx`

- [ ] Add failing component tests proving the notice is non-modal, dismissible, keyboard accessible, and links to service settings.
- [ ] Prove no notice appears for Tautulli-only, Tracearr-only, neither, or dismissed states.
- [ ] Implement the query/mutation and invalidate the notice query after dismissal.
- [ ] Render an ordinary banner/card without backdrop, focus trap, `aria-modal`, or navigation interception.
- [ ] Use copy that explains preservation or recovery without claiming deleted secrets can be restored.
- [ ] Run `pnpm --filter @arr/web test -- tautulli-provider-notice useSystem` and commit: `feat: replace tautulli wizard with notice`.

## Task 5: Freeze and validate the wave

- [ ] Run `pnpm exec prisma validate --schema apps/api/prisma/schema.prisma` and regenerate the Prisma client through the repository script.
- [ ] Run focused API and web tests from Tasks 2-4.
- [ ] Run `pnpm run format`, `pnpm --filter @arr/shared build`, `pnpm run typecheck`, `pnpm run test`, and `pnpm run lint`.
- [ ] Run `pnpm run build` because startup, schema, routes, and global UI changed.
- [ ] Delegate one `regression_reviewer` pass over the frozen diff. Record all evidence-backed in-scope findings once, apply one correction batch, and re-run affected checks.
- [ ] Confirm `git diff --check` and no secrets/generated browser artifacts entered the diff.
