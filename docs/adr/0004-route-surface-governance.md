# ADR 0004: Route Surface Governance

- **Status:** Accepted
- **Date:** 2026-04-13
- **Deciders:** Backend maintainers
- **Supersedes:** —

## Context

The HTTP surface spans roughly twenty top-level route groups across auth,
ARR services, automation, media servers, and operator/system tooling.
Some of these are heavily depended on by the bundled web UI (and
plausibly by external scripts that operators wire up themselves), while
others are dashboard-only synthetic surfaces that ship in lockstep with
the frontend.

A reviewer landing on a PR that touches a route had no quick answer to:

1. **Is this route intended to be stable?** Will breaking the response
   shape break someone's tooling, or just break the next dashboard
   build?
2. **Who is this route for?** External integrations? The operator's
   own scripts? The dashboard only?
3. **How careful do I need to be?** Does this need a CHANGELOG entry,
   release-notes call-out, or coordinated frontend update?

The previous answer was "read the route, read the consumers, guess."
That works at twenty routes; it gets worse as the surface grows. We did
not, however, want to introduce semantic API versioning (`/v1`, `/v2`)
or a heavyweight registry framework — both are theatre at this scale,
and the app is single-admin self-hosted, not a multi-tenant platform
API.

## Decision

Introduce a single typed manifest at
[`apps/api/src/routes/route-manifest.ts`](../../apps/api/src/routes/route-manifest.ts)
that:

1. Lists every top-level route group (public + protected) with a
   canonical `path`, a `register` function reference, an optional Fastify
   `prefix`, a one-line `summary`, and a `maturity` tier.
2. Is the **only** mechanism by which a route group reaches the server —
   `bootstrap/public-routes.ts` and `bootstrap/protected-routes.ts`
   iterate the manifest. There is no parallel list to keep in sync.
3. Is mirrored in [`docs/API-ROUTES.md`](../API-ROUTES.md)'s "Route
   Surface Governance" section, with a contract test
   (`route-manifest.test.ts`) that fails if any manifest path is missing
   from the doc.

### Maturity tiers

| Tier | Audience | Change discipline |
|---|---|---|
| `stable` | Bundled web UI **and** potential external scripts/integrations | Preserve request/response shape within a minor. CHANGELOG breaking changes. |
| `operator` | Self-hosting operator (single-admin) via UI or scripted ops | Real-world side effects (restart, restore, configure providers). Document behavior changes in CHANGELOG. |
| `internal` | Bundled dashboard only — frontend ships in lockstep | Free to reshape with a coordinated frontend update in the same PR. |
| `experimental` | Opt-in, iterating | May move or be removed. Currently empty; reserved. |

The set is deliberately small. Adding more tiers (e.g. `deprecated`,
`beta`) is cheap when there is real demand, but the cost of a tier no
one understands is high — reviewers stop trusting any of them.

## Why this shape

1. **One source of truth, by construction.** The bootstrap files iterate
   the manifest. A contributor cannot register a route "around" the
   manifest without obviously bypassing the bootstrap loop, which a
   reviewer will catch. Drift between governance metadata and actual
   registration is structurally impossible.
2. **Prefix-level, not handler-level.** The single-admin model means
   "authenticated" *is* "authorized" (see ADR-0003), and route groups
   already cluster cleanly by domain. Per-handler annotations would add
   noise without adding signal.
3. **Doc + test, not codegen.** The doc table is hand-written. A small
   substring-based test asserts that every manifest path appears in
   `docs/API-ROUTES.md`, so contributors get drift detection without a
   fragile generation pipeline. The full table fits on one screen and is
   trivial to maintain.
4. **No URL versioning.** This codebase ships a bundled frontend; a
   `/v1` prefix would just be ceremony. If we ever need to support
   multiple incompatible clients, that decision deserves its own ADR.

## Why not …

- **Semantic versioning (`/api/v1/…`).** Adds path noise and a migration
  story we do not need today. Re-evaluate if external API consumers
  become a real audience.
- **Per-handler `@stable` / `@internal` decorators.** Invasive to add,
  easy to forget, and the natural unit is the route group, not the
  handler. The manifest captures the same information at the right
  granularity.
- **A generated route registry / OpenAPI doc.** Worth considering later,
  but premature now: most consumers are the bundled UI's typed React
  Query hooks, not external clients. OpenAPI generation is its own
  multi-week project; the manifest is a one-PR change.
- **Comments-only convention** ("just write `// stable` above the
  route"). No drift detection, no machine-readable surface, no test
  coverage. Falls out of sync within months.

## Consequences

### Positive

- A reviewer can answer "is this stable / who is it for / how careful do
  I need to be?" by reading one row in `docs/API-ROUTES.md`.
- Adding a new route group is a one-place edit (manifest), plus a row in
  the doc. The test fails fast if either is forgotten.
- Bootstrap files shrink to ~30 lines apiece and read as the policy
  ("for each group, register it under the auth scope") rather than a
  hand-maintained list.
- The tier vocabulary gives PR descriptions and CHANGELOG entries a
  shared shorthand: "this is an `internal` surface, dashboard updated
  in the same PR" closes a class of review questions immediately.

### Negative / trade-offs

- The manifest concentrates a lot of imports in one file. Acceptable —
  it's an index, not logic.
- Maturity is a judgment call at the group level, not the handler level.
  If a single group ends up mixing stable and internal endpoints, the
  group must either be split or graded down to its weakest tier. So far
  every group has fit cleanly into one tier.
- The doc-table check is a substring match. Strong enough to catch
  forgotten rows; weak enough that it won't catch a wrong tier label
  in the doc. That is intentional — over-fitting the test would make it
  noisy without catching real bugs. Wrong labels are caught at PR review.

## Follow-ups

- If `experimental` ever holds a real entry, add a release-notes
  template line ("⚠️ Experimental — may change in 2.x").
- If external API consumers materialize, revisit URL versioning in a
  new ADR rather than retrofitting it onto the manifest.
- If a `deprecated` tier is added, also add a release-notes line and a
  removal-window convention (e.g., "deprecated routes are removed no
  sooner than the second minor release after deprecation").
