# Unified Rule Grammar — Design

- **Status:** DRAFT for review (gates ADR-0006 / Bucket A4 implementation)
- **Date:** 2026-06-09
- **Inputs:** code survey of all five rule systems on `next` @ `ada897be`
- **Charter:** §5.2, Bucket A4; ADR-0006 (incl. 2026-06-09 amendment)

## 1. What the survey found (and what it corrects)

Five systems were surveyed. They fall into **two storage classes**, which
corrects ADR-0006's premise that all five store rules:

| Surface | Storage | Stored rule documents? | Migration class |
|---|---|---|---|
| Library Cleanup | `LibraryCleanupRule` — `ruleType` + `parameters` JSON + optional `operator`/`conditions` composite | **Yes** (47 condition kinds) | Document migration |
| Auto-Tagger | `AutoTagRule` — mirrors LibraryCleanupRule | **Yes** (same kinds + list-membership) | Document migration |
| Notifications | `NotificationRule` — `conditions` JSON (flat array of `{field, operator, value}`) + action columns | **Yes** (generic field-match conditions) | Document migration |
| Queue Cleaner | `QueueCleanerConfig` — flat typed columns + JSON-string arrays; evaluation order hardcoded | **No** | Adapter only — no storage migration |
| Hunting | `HuntConfig` — flat typed columns + include/exclude lists + AND/OR toggle | **No** | Adapter only — no storage migration |

**Consequence:** the unified migration (ADR-0006 §2) applies to **three**
surfaces, not five. Queue Cleaner and Hunting keep their config schemas;
their evaluators are re-expressed against the unified engine internally
(an adapter translating config → grammar at evaluation time), with zero
user-visible storage change. This shrinks A4's riskiest dimension by
40%.

### 1.1 The two condition styles that must unify

- **Kind+params style** (cleanup / auto-tag): a condition is
  `{ ruleType: "plex_last_watched", parameters: { operator: "older_than", days: 14 } }`.
  Operators are **per-kind enums** (e.g. `older_than|never` for watch
  ages, `includes_any|excludes_all` for user lists). 47 kinds, grouped
  by data source (basic ×9, file-metadata ×7, Seerr ×10, Tautulli ×3,
  Plex ×8, Jellyfin ×7, misc ×8 incl. tmdb/trakt list membership).
- **Field-match style** (notifications): a condition is
  `{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" }`
  with five universal operators
  (`equals|not_equals|contains|greater_than|in`) over payload fields
  (`eventType`, `title`, `body`, `metadata.*`).

### 1.2 Composition reality

- Cleanup/auto-tag: **one-level** AND/OR composite (`operator` +
  `conditions[]`); no NOT; no nesting.
- Notifications: **flat implicit AND** across the conditions array;
  first-matching-rule-wins across rules (priority-ordered).
- Nobody nests. Nobody has rule-level NOT.

### 1.3 Semantics that must be preserved exactly

1. **Permissive null** (cleanup family): missing data → condition does
   not match; never an error. (E.g. item absent from the Plex watch map
   → `plex_last_watched` returns no-match.) Changing this silently
   changes which items cleanup rules flag.
2. **"Never watched" inference** (cleanup family): `plex_watch_count`
   with `less_than` infers 0 plays for items with a file, added N+ days
   ago, absent from the watch map.
3. **First-match-wins + priority** (notifications): exactly one rule's
   action fires per event.
4. **Action↔field coupling** (notifications): `throttle`/`route`/
   `quiet_hours` carry extra columns. **Actions are out of grammar
   scope** — the grammar unifies predicates only; actions remain
   domain-owned columns.
5. **Case-insensitive string matching** throughout the cleanup family;
   notifications' `equals` is case-sensitive but `contains` is not.
   The grammar must not "harmonize" this — each kind keeps its
   documented semantics.

## 2. The grammar

### 2.1 Shape (serialization v1)

```ts
// One predicate. The kind+params style is the base form.
type Condition = {
  kind: string;                       // e.g. "plex_last_watched", "field_match"
  params: Record<string, unknown>;    // validated by the kind's Zod schema
};

// Composite. Schema permits recursion; v1 UI and validators restrict
// depth to 1 (matching every existing rule). Depth is a future unlock,
// not a migration burden.
type ConditionGroup =
  | { all: ConditionNode[] }          // AND
  | { any: ConditionNode[] };         // OR

type ConditionNode = Condition | ConditionGroup;

// The stored document envelope (per rule row, in the existing JSON columns)
type RuleDocument = {
  version: 1;
  root: ConditionNode;
};
```

Notifications' field-match style becomes **one kind in the unified
vocabulary** rather than a parallel grammar:

```ts
// kind: "field_match"
params: {
  field: "eventType" | "title" | "body" | `metadata.${string}`;
  operator: "equals" | "not_equals" | "contains" | "greater_than" | "in";
  value: string | number | string[];
}
```

### 2.2 Context registry

Each domain registers an **evaluation context**: the set of kinds legal
in that domain plus the data the evaluator needs.

```ts
type RuleContext = {
  id: "library-cleanup" | "auto-tag" | "notifications"
    | "queue-cleaner" | "hunting";
  kinds: Set<string>;                  // legal condition kinds
  buildEvalInput: (...domainArgs) => EvalInput;  // domain-owned
};
```

- `library-cleanup` and `auto-tag` share the 47-kind vocabulary (the
  existing shared-evaluator relationship, formalized). Auto-tag
  additionally registers the list-membership maps in its eval input.
- `notifications` registers `field_match` (and gains nothing else in
  v1 — its vocabulary is intentionally tiny and event-shaped).
- `queue-cleaner` / `hunting` register internal kinds for their config
  semantics (`stalled`, `tag_membership`, `status_hierarchy`, …) used
  only by their adapters; not exposed in the composer in v1.
- The engine validates at parse time that every kind in a document is
  legal for the context — a cleanup rule cannot smuggle a
  `field_match` on a notification payload and vice versa.

### 2.3 What deliberately does NOT unify

- **Actions** (notifications' suppress/throttle/route/quiet_hours;
  cleanup's flag-for-review; auto-tag's tag writes) — domain-owned.
- **Trigger model** (event-driven vs scheduled) — domain-owned.
- **Operator vocabulary across kinds** — per-kind enums stay. A global
  operator set would force semantic changes (see §1.3.5) for zero user
  value.
- **Queue-cleaner / hunting storage** — config columns stay; their UIs
  stay; only the evaluation internals route through the engine.

## 3. Migration strategy: parse-time versioning, no eager rewrites

**Format unification does not rewrite stored rows.** The parser
version-detects each document at load time:

- JSON with top-level `ruleType` (cleanup/auto-tag) or a bare
  conditions array (notifications) → **legacy v0**; a small mapper
  converts to grammar nodes in memory.
- JSON with `version: 1` → parsed directly.

Rules are written in v1 **only when created or edited** (lazy
convergence). The v0 mappers live in one quarantined module with
fixture tests against real 2.x rows.

| Surface | Load path | Eager rewrite? |
|---|---|---|
| Library Cleanup | v0 mapper (near-identity) | **No** |
| Auto-Tagger | same v0 mapper | **No** |
| Notifications | v0 mapper (`{field,operator,value}` → `field_match`) | **No** |
| Queue Cleaner | config adapter (not a document) | **No** |
| Hunting | config adapter (not a document) | **No** |

Consequences:

1. **Notifications' stable-tier promise survives unification** — its
   stored rows are untouched until the user edits a rule. The breaking
   change ADR-0006 assumed ("bundle into 3.0 or never") does not exist.
2. **ADR-0006's 5-point contract is rescoped to semantic changes
   only** — passes that alter what rules *mean* (the Tautulli
   retirement, §3.1). Format conversion needs no backup file because
   the original rows are never touched; the untouched rows ARE the
   backup.
3. Mixed v0/v1 documents coexist in the DB indefinitely. Accepted:
   write-on-edit converges naturally; an optional "migrate all now"
   maintenance action can be added if mixed-format debugging ever
   becomes a real cost.
4. Future format changes add a v1→v2 mapper — the `version` field makes
   every document self-describing.

### 3.1 The Tautulli pass — the only eager (semantic) migration

Retiring `tautulli_last_watched` / `tautulli_watch_count` /
`tautulli_watched_by` changes what stored rules *mean*, so it runs as
an eager pass under the full ADR-0006 5-point contract — and it
operates on **v0 documents directly** (read JSON, find tautulli kinds,
transform, write back, report). It does not require the unified engine,
which restores A2's independence from A4 (see §4).

1. Conditions are counted and listed per rule in the migration report
   (feeds the A2 dialog's disclosure: "N of your rules referenced
   Tautulli watch data").
2. Composite handling: if removing the Tautulli condition leaves the
   composite empty → the rule is **disabled** (not deleted), flagged
   `migration: tautulli-orphaned`. If siblings remain → the condition
   is removed and the rule stays active, flagged
   `migration: tautulli-condition-dropped`.
3. The backup file (`/config/rules-pre-3.0/<surface>.json`) preserves
   the original documents (warranted here — this pass DOES rewrite
   rows).
4. Post-A2 (Tracearr-era), users can re-express watch conditions with
   the Plex/Jellyfin kinds or future Tracearr kinds; the pass does NOT
   auto-rewrite `tautulli_*` → `plex_*` (different data sources;
   silent semantic swaps violate the trust thesis).

The v0-parsing utilities this pass builds are reused by A4's lazy
mappers — nothing here is throwaway.

## 4. Implementation order

**Resequencing note (2026-06-09):** with eager format migration
eliminated (§3), A2 no longer depends on A4 — its Tautulli pass is
self-contained over v0 documents. **A2 lands first** (it is fully
specified; ADR-0007), establishing the migration-pass pattern
(backup / transactional / report / dry-run) in miniature. A4 follows.

A4 itself, gated by **differential parity testing** — the engine's
acceptance criterion is "identical decisions to the legacy evaluator on
identical inputs," proven per surface before cutover (strangler
pattern, not big-bang):

1. `packages/shared`: grammar types + Zod schemas + per-kind param
   schemas lifted from `ruleParamSchemaMap`, plus the v0 mappers.
2. Engine core: version-detect → parse → validate-against-context →
   evaluate. Seeded from cleanup's `rule-evaluators.ts`; decompose the
   82 KB file along kind-category lines as part of the lift.
3. **Parity suite**: legacy evaluator vs engine on identical eval
   contexts — fixtures harvested from real rule rows (the dev DB has
   live cleanup/auto-tag rules) plus synthetic edge cases (null
   handling, never-watched inference, case sensitivity). Green parity
   gates each cutover.
4. Cleanup cut over → auto-tag cut over (shared evaluators make this
   nearly one step).
5. Notifications: v0 mapper + adapter at load; **no storage change**.
   Parity-tested against its 5 operators and first-match-wins
   semantics.
6. Queue-cleaner + hunting adapters (internal; can trail indefinitely
   without blocking anything).
7. Composer UI (Operator Console flagship) — after the engine
   stabilizes; seeded from `features/rule-criteria/`. Writes v1 on
   save, which is what converges stored documents over time.

## 5. Open questions for review

1. **Where do the shared schemas live** — `packages/shared` (frontend
   composer needs the types + Zod for validation) vs `apps/api/lib`
   (keeps grammar server-private)? Leaning `packages/shared` since the
   composer must validate client-side.
2. ~~Version field placement~~ — **resolved by the migration strategy**:
   per-document `version` is load-bearing for parse-time
   version-detection (§3); not optional.
3. **Notifications metadata fields**: the engine supports
   `metadata.*` but the UI never exposed it. Keep API-only in v1, or
   surface it in the composer? Leaning keep API-only (no user demand
   signal yet).
4. **Queue-cleaner/hunting in the composer**: v1 keeps them
   adapter-only (their config UIs stay). Does the Operator Console
   eventually edit them through the composer (v1.5/v2), or are flat
   config UIs the right permanent shape for config-class surfaces?
