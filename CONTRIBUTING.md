# Contributing to Arr Dashboard

Thanks for your interest in contributing! This guide will help you get started.

## Quick Start

```bash
pnpm install && pnpm run dev  # API (3001) + Web (3000)
```

**Requirements:** Node.js 22+, pnpm 10+

## Development Guide

The main development reference is [`CLAUDE.md`](CLAUDE.md) — it covers:
- Architecture (Fastify + Next.js + Prisma monorepo)
- Code style and conventions (Biome, TypeScript strict mode)
- Key patterns (auth, encryption, API proxy, theming)
- How to add features (routes, pages, database changes)

## Submitting Changes

1. **Fork** the repo and create a branch from `main`
2. **Follow existing patterns** — check `CLAUDE.md` for conventions
3. **Test your changes**:
   ```bash
   pnpm run lint        # Biome (API) + ESLint (Web)
   pnpm run typecheck   # TypeScript strict mode
   pnpm run test        # Vitest unit tests
   pnpm run build       # Production build
   ```
4. **Open a PR** against `main` with a clear description

## What Makes a Good PR

- **Focused** — One concern per PR
- **Tested** — Types pass, lint clean, tests pass
- **Documented** — Update CLAUDE.md if you add patterns, routes, or conventions

## Architecture-Affecting Changes

Some changes need a docs update beyond code comments. Use this checklist
to decide what to touch.

### Update the relevant domain doc when you …

The domain docs under [`docs/domains/`](docs/domains/) are short
operating manuals: where code goes, what invariants must hold, what
fails in the wild. Update the appropriate doc when you:

- add or remove a service / scheduler / auth method / `/system/*` endpoint,
- change an invariant listed in a domain doc (most common: a new
  ownership rule, a new encryption requirement, a relaxation of an
  existing constraint),
- introduce a new shared abstraction the domain depends on
  (e.g., a new client factory, a new pure evaluator),
- change the "where to add new code" answer for that domain.

| Domain | Doc |
|---|---|
| Auth, sessions, encryption | [`docs/domains/auth.md`](docs/domains/auth.md) |
| Background jobs, registry | [`docs/domains/schedulers.md`](docs/domains/schedulers.md) |
| External integrations | [`docs/domains/services.md`](docs/domains/services.md) |
| Operator diagnostics surface | [`docs/domains/system.md`](docs/domains/system.md) |

Domain docs are *not* exhaustive references — per-route response shapes
live in [`docs/API-ROUTES.md`](docs/API-ROUTES.md), auth internals live
in [`docs/AUTH.md`](docs/AUTH.md). Keep domain docs concise; if you find
yourself documenting a per-handler detail, that probably belongs as a
comment at the call site instead.

### Write an ADR when …

Open a new file under [`docs/adr/`](docs/adr/) (next sequential number,
copy the shape of an existing one) when a change has any of these
properties:

- **Cross-cutting** — touches multiple domains or sets a precedent
  others will follow (e.g., the scheduler registry, the protected-route
  model, the security-posture evaluator pattern).
- **Reversed direction** — replaces or significantly reshapes an
  existing approach. The ADR captures *why we changed our mind*.
- **Reverse-engineering risk** — a future contributor would otherwise
  need to read across many files to understand the intent. Especially
  true for "we explicitly chose not to do X" decisions.
- **Trade-off worth recording** — there was a real alternative we
  rejected, and the reasoning is non-obvious.

If a change is just "added a feature in the obvious place," it does
not need an ADR. ADRs are expensive to read; reserve them for the
decisions whose absence would cost a future reader an hour.

### Route Surface Governance

Every top-level API route group has a **maturity tier** declared in
[`apps/api/src/routes/route-manifest.ts`](apps/api/src/routes/route-manifest.ts).
The tier tells you how careful to be when changing the route's
contract. See
[`docs/adr/0004-route-surface-governance.md`](docs/adr/0004-route-surface-governance.md)
for the full definitions; the short version:

| Tier | Change discipline |
|---|---|
| `stable` | Preserve request/response shape within a minor. CHANGELOG breaking changes. |
| `operator` | Treat behavior changes as user-visible. Document in CHANGELOG. |
| `internal` | Free to reshape — update the bundled frontend in the **same PR**. |
| `experimental` | May move or be removed. Mark loudly in release notes. |

When you add a new route group:

1. Add an entry to `route-manifest.ts` (this is what registers the
   route — the bootstrap files iterate the manifest).
2. Add a row to the governance table in
   [`docs/API-ROUTES.md`](docs/API-ROUTES.md).
3. The contract test
   (`apps/api/src/routes/__tests__/route-manifest.test.ts`) will fail if
   either is forgotten.

When you change an existing route, check its tier first:

- `stable` / `operator` shape change → CHANGELOG entry required.
- `internal` shape change → update the consuming frontend code in the
  same PR, no CHANGELOG entry needed.
- Promoting a route from `internal` to `stable` is a deliberate
  decision; mention it in the PR description.

### Architecture-affecting examples

- ✅ Adding a new auth method (Auth domain doc + ADR if it changes the
  invariants).
- ✅ Replacing the in-process scheduler registry with a persisted store
  (Schedulers domain doc + ADR superseding 0001).
- ✅ Adding a new severity tier to the security posture evaluator
  (System domain doc + amend ADR-0002).
- ❌ Adding a new field to an existing API response (CHANGELOG entry,
  no doc/ADR change).
- ❌ Tightening a Zod schema (no doc change unless an invariant moved).

When in doubt, ask in the PR — it is cheaper than a stale doc.

## Reporting Issues

- **Bugs**: Use the [bug report template](https://github.com/Kha-kis/arr-dashboard/issues/new?template=bug_report.yml)
- **Features**: Use the [feature request template](https://github.com/Kha-kis/arr-dashboard/issues/new?template=feature_request.yml)
- **Security**: See [SECURITY.md](SECURITY.md) — do NOT open public issues for vulnerabilities

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
