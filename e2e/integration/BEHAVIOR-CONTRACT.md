# Integration Behavior Contracts

This document records the stable, user-visible behaviors that the integration
suite pins down, and *why* each one is contract (not implementation detail).
Change these behaviors deliberately — the specs below will break.

## 1. Dashboard Configured Instances is collapsed by default

`Configured Instances` on the dashboard overview is a disclosure section. On
first render it is **collapsed** and shows a one-line summary ("N active
services across ..."). Clicking the header expands it into the per-instance
table; clicking again collapses it.

- Why: the overview is a starting summary, not a full inventory (see
  `docs/3.0-ui-ux-audit.md`). Detailed instance lists belong in Settings.
- Accessibility: the header is a real disclosure toggle (`aria-expanded`,
  `aria-controls` pointing at the panel), so the collapsed/expanded state is
  programmatically discoverable.
- Spec: `specs/03-dashboard-overview.spec.ts` asserts the collapsed summary,
  then expands and asserts the instance rows and service-type badges.

## 2. Sidebar navigation derives from the route registry

The navigation sweep iterates the same `NAVIGATION_GROUPS` registry the app
sidebar uses (`apps/web/src/components/layout/navigation.ts`). The app is the
single source of truth for "what pages exist"; the spec imports it rather than
hard-coding a route list.

- Why: a hard-coded list in the spec silently goes stale whenever a route is
  added or removed. Deriving it keeps the sweep honest.
- Spec: `specs/16-navigation.spec.ts` builds the sidebar sweep and the direct
  URL sweep from `NAVIGATION_GROUPS`.

## 3. Seerr seeding fails loudly when pending requests cannot be created

Seerr requires a media server to create its first admin user, so it cannot be
bootstrapped at compose-up time. The Jellyfin setup wizard runs first (as a
Playwright setup fixture), then Seerr is logged into Jellyfin, Radarr is
connected, a non-admin requester is created, and movie + TV requests are
submitted as that requester so they stay **pending**.

- If fewer than 2 pending requests exist after seeding, the fixture throws —
  the Requests spec depends on pending requests, and a silently empty queue
  would turn real failures into skips.
- The seeding is idempotent across re-runs: an already-seeded Seerr is
  detected via the authenticated request count and skipped.
- Bootstrap only waits for Seerr readiness and writes connection details; all
  mutation happens in `fixtures/jellyfin-setup.setup.ts`.
- Spec: `specs/19-requests.spec.ts` (approval queue, keyboard, ARIA).

## 4. TRaSH Guides error assertions run after content loads

The TRaSH Guides page fetches remote guide content at runtime. "No error
alerts" must be asserted only after the instance list / content has rendered —
a blind short wait is flaky and proves nothing.

- Why: the page can legitimately render nothing while fetching; asserting "no
  alerts" against an empty shell is a false pass.
- Spec: `specs/11-trash-guides.spec.ts` waits for instance-refs content before
  asserting the absence of error alerts.