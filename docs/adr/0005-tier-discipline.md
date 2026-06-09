# ADR 0005: Tier Discipline

- **Status:** Accepted
- **Date:** 2026-06-09
- **Deciders:** Backend maintainers
- **Supersedes:** — (amends ADR-0004)
- **Charter:** [3.0 charter](../3.0-charter.md) §5.1, Bucket A1

## Context

ADR-0004 introduced the route-manifest maturity tiers (`stable` /
`operator` / `internal` / `experimental`) but deliberately left
promotion and demotion criteria undefined — at the time, `experimental`
was empty and every group's tier was assigned once, by judgment.

Two years of 2.x development drifted tiers away from reality. The 3.0
domain inventory (40 domains, six parallel audits) found:

- **Auto-Tagger and Label Sync sit at `experimental`** despite having
  zero debt signals, full `validateRequest` coverage, and the cleanest
  backend architecture in the codebase.
- **Hunting and Queue Cleaner sit at `internal`** despite being
  operator-facing scheduler surfaces that operators script against.
- **qui sits at `experimental`** despite passkey-hardening, extensive
  test coverage, and shipping as the headline feature of v2.20.
- **Tautulli sits at `stable`** while the project's direction (ADR-0007)
  removes it entirely.

Tier labels that disagree with maturity are worse than no labels: a
reviewer who learns that `experimental` sometimes means "cleanest code
in the repo" stops trusting every tier. ADR-0004 predicted exactly this
("the cost of a tier no one understands is high").

## Decision

### 1. Promotion criteria

A route group may be promoted one tier (experimental → internal →
operator → stable, skipping allowed when criteria for the target tier
are met) when **all** of:

1. **Zero validation bypasses** — every mutation handler parses its body
   via `validateRequest()`; no inline `Body:` generics without it.
2. **Test coverage exists** at the route or service layer (not
   necessarily exhaustive — present and meaningful).
3. **Shape stability** — the request/response shape survived the last
   two minor releases without breaking change, or the group is new and
   its shape was reviewed against the target tier's discipline.
4. **Docs parity** — the group's row in `docs/API-ROUTES.md` is accurate
   (enforced by the existing manifest contract test).

### 2. Demotion / removal criteria

- Demotion (any tier → `experimental`) requires a release-notes entry
  and a one-line rationale in the manifest summary.
- **Removal requires a deprecation path decided in an ADR** (see
  ADR-0007 for the Tautulli case), including the user-migration story.
  "Stable" is a promise; breaking it silently is not an option.

### 3. The 3.0 reshuffle

Applied as part of Bucket A (one PR, manifest + docs + release notes):

| Group | 2.x tier | 3.0 tier | Basis |
|---|---|---|---|
| Auto-Tagger | experimental | operator | criteria 1–4 met; sub-arcs 1–4 shipped |
| Label Sync | experimental | operator | criteria 1–4 met; any-to-any arc complete |
| Hunting | internal | operator | operator-facing scheduler; criteria met |
| Queue Cleaner | internal | operator | operator-facing scheduler; criteria met |
| TRaSH Guides | internal | operator | flagship feature set; criteria met after the Bucket A `validateRequest` migration of deployment routes |
| qui | experimental | stable | hardened, tested, shipped headline in v2.20 |
| Cross-seed (rides `/api/qui`) | experimental | stable | graduates with qui |
| Tautulli | stable | **removed** | ADR-0007 |

TRaSH Guides' promotion is **conditional on** the `Body:` →
`validateRequest` migration (charter Bucket A6) landing first — it
currently fails criterion 1.

## Why this shape

1. **Criteria are mechanically checkable.** Three of the four promotion
   criteria can be verified by grep/test-run, which means tier debates
   in PR review become evidence questions, not taste questions.
2. **Removal goes through an ADR, not a PR description.** The single
   place a "stable" promise can be withdrawn is a document with a
   migration story — which is what makes the promise worth anything.
3. **The reshuffle is one atomic PR.** Trickling tier changes across the
   cycle would leave the manifest internally inconsistent for months.

## Why not …

- **Automatic tier scoring in CI.** Criteria 1–2 could be computed, but
  criterion 3 (shape stability) needs release history and criterion 4
  needs human judgment about doc accuracy. A half-automated score would
  be trusted as if fully automated. Keep it a review-time checklist.
- **A `deprecated` tier for Tautulli.** Considered (ADR-0004 reserved
  the idea). Rejected because 3.0 removes Tautulli outright rather than
  deprecating it across a window — a tier that exists for one group for
  one release is ceremony. If a future removal needs a long window,
  revisit.
- **Re-grading everything from scratch.** The inventory found the other
  ~19 groups' tiers accurate. Only mismatches move; stability of the
  vocabulary is the point.

## Consequences

### Positive

- Tier labels regain their meaning before 3.0 ships them to a larger
  audience (the `:next` preview channel).
- "Why is this experimental?" has a checkable answer, and the path out
  of `experimental` is documented for future features (Tracearr will
  enter at `experimental` and graduate by these criteria).

### Negative / trade-offs

- The reshuffle widens the `stable`+`operator` surface, which raises the
  bar for future changes to those groups (CHANGELOG discipline). That is
  the intended cost of honesty.
- Criterion 3 ("two minor releases") is awkward during the 3.0 cycle
  itself, when there are no 3.x minors yet. For the cycle, "two preview
  milestones (alpha/beta)" substitutes.

## Follow-ups

- Apply the reshuffle in Bucket A; verify the manifest contract test
  still passes with the new tiers.
- Tracearr's route group (ADR-0007) enters at `experimental`; schedule
  its graduation review at 3.0-rc.
- When the first 3.x minor ships, retire the preview-milestone
  substitution for criterion 3.
