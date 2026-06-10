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

## 3. Per-surface migration mapping (ADR-0006 5-point contract)

| Surface | Transform | Risk |
|---|---|---|
| Library Cleanup | Near-identity: `{ruleType, parameters}` → `{version:1, root:{kind, params}}`; composites → `{all:[…]}`/`{any:[…]}` | Low — shape-preserving envelope |
| Auto-Tagger | Same as cleanup | Low |
| Notifications | Each `{field,operator,value}` → `{kind:"field_match", params:{…}}`; array → `{all:[…]}` | Low — lossless and mechanical |
| Queue Cleaner | **None** (config unchanged; adapter internal) | n/a |
| Hunting | **None** (config unchanged; adapter internal) | n/a |

### 3.1 The Tautulli test case (ADR-0006/0007 amendments)

During the cleanup/auto-tag migration, conditions with kinds
`tautulli_last_watched`, `tautulli_watch_count`, `tautulli_watched_by`:

1. Are counted and listed per rule in the migration report (feeds the
   A2 dialog's disclosure: "N of your rules referenced Tautulli watch
   data").
2. Composite handling: if removing the Tautulli condition leaves the
   composite empty → the rule is **disabled** (not deleted), flagged
   `migration: tautulli-orphaned`. If siblings remain → the condition
   is removed and the rule stays active, flagged
   `migration: tautulli-condition-dropped`.
3. The backup file (`/config/rules-pre-3.0/<surface>.json`) preserves
   the original documents regardless.
4. Post-A2 (Tracearr-era), users can re-express watch conditions with
   the Plex/Jellyfin kinds or future Tracearr kinds; the migration does
   NOT auto-rewrite `tautulli_*` → `plex_*` (different data sources;
   silent semantic swaps violate the trust thesis).

## 4. Implementation order (A4)

1. `packages/shared` (or `apps/api/src/lib/rules/`): grammar types +
   Zod schemas + per-kind param schemas lifted from
   `ruleParamSchemaMap` (cleanup's existing per-kind validation).
2. Engine core: parse → validate-against-context → evaluate. Seeded
   from cleanup's `rule-evaluators.ts` (per ADR-0006); decompose the
   82 KB file along kind-category lines as part of the lift.
3. Cleanup + auto-tag re-pointed at the engine (their evaluators ARE
   the engine; this step is mostly file moves + context wiring).
4. Notifications adapter + document migration (the only behavioral
   risk; ship with fixture tests against real 2.x rule rows).
5. Queue-cleaner + hunting adapters (internal; can trail).
6. Migrations per the 5-point contract; Tautulli counting wired for A2.
7. Composer UI (Operator Console) — after the engine stabilizes;
   seeded from `features/rule-criteria/`.

## 5. Open questions for review

1. **Where do the shared schemas live** — `packages/shared` (frontend
   composer needs the types + Zod for validation) vs `apps/api/lib`
   (keeps grammar server-private)? Leaning `packages/shared` since the
   composer must validate client-side.
2. **Version field**: `version: 1` on every document vs schema-level
   versioning per surface? Leaning per-document — it makes the next
   migration self-describing.
3. **Notifications metadata fields**: the engine supports
   `metadata.*` but the UI never exposed it. Keep API-only in v1, or
   surface it in the composer? Leaning keep API-only (no user demand
   signal yet).
4. **Queue-cleaner/hunting in the composer**: v1 keeps them
   adapter-only (their config UIs stay). Does the Operator Console
   eventually edit them through the composer (v1.5/v2), or are flat
   config UIs the right permanent shape for config-class surfaces?
