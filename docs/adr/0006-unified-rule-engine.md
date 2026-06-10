# ADR 0006: Unified Rule Engine + Migration Policy

- **Status:** Accepted
- **Date:** 2026-06-09
- **Deciders:** Backend maintainers
- **Supersedes:** —
- **Charter:** [3.0 charter](../3.0-charter.md) §5.2, Bucket A4, §6.2; decision log #7, #9

## Context

Five operations-workflow domains each grew their own rule/predicate
machinery, at different times, under different pressures:

| Domain | Engine | Shape |
|---|---|---|
| Library Cleanup | `lib/library-cleanup/rule-evaluators.ts` (~82 KB) | condition-tree predicate engine |
| Auto-Tagger | reuses library-cleanup's `evaluateSingleCondition` + shared `features/rule-criteria/` UI | predicate engine (borrowed) |
| Queue Cleaner | `lib/queue-cleaner/rule-evaluators.ts` | its own predicate DSL over queue items |
| Notifications | `lib/notifications/rule-engine.ts` | its own `RuleCondition` predicate language |
| Hunting | `lib/hunting/hunt-filters.ts` | filter abstraction over wanted items |

(Label Sync's `strategy-registry.ts` is adjacent but is a tag
*transformer*, not a predicate engine — it consumes the unified engine's
output rather than replacing its own grammar.)

The duplication has real costs: three separate condition-builder UIs,
three serialization formats in the database, bug fixes that land in one
evaluator and not its siblings, and no way to express cross-domain
rules ("when an item matches X, notify AND tag AND exempt from
cleanup") — which the Operator Console's rule composer (charter §2.1)
requires.

Notifications is a `stable`-tier surface, so unifying its stored-rule
format is a breaking change. Per the charter: bundle it into 3.0 or
never.

## Decision

### 1. One grammar, per-domain contexts

Build a single rule grammar — condition trees with typed field
references, comparison operators, and AND/OR/NOT composition — consumed
by every domain above. Each domain contributes an **evaluation
context** (the field vocabulary its items expose: queue items expose
`status`/`trackerHealth`, library items expose `genre`/`watchState`,
etc.). The engine is context-generic; the contexts are domain-owned.

The library-cleanup evaluator is the **seed implementation** — it is the
largest, the most battle-tested, and already shared with Auto-Tagger.
The other engines migrate onto it; it does not migrate onto them.

The full grammar schema is a Bucket A design deliverable (charter §11),
not part of this ADR. This ADR fixes the *direction* and the *migration
contract*.

### 2. Migration policy (per stored-rule surface)

Five surfaces store rules that must survive the upgrade: Notifications,
Library Cleanup, Queue Cleaner, Hunting filters, Auto-Tagger. Each
migration ships with the same contract:

1. **Backup before mutation** — on first 3.0 boot, the pre-migration
   rules are written to `/config/rules-pre-3.0/<surface>.json` before
   any row is rewritten.
2. **Migrate in a transaction** — per-surface, all-or-nothing. A failed
   migration leaves the surface on its legacy format and surfaces a
   Pulse item; it must not half-convert.
3. **One-time review notification** — "Rules migrated — review in
   Operator Console," linking to a dry-run preview that shows each
   migrated rule's matches under the new engine.
4. **Rollback path** — stop 3.0, restore `<surface>.json`, downgrade the
   Docker tag to the last 2.x. Documented in CHANGELOG per surface.
5. **CHANGELOG table** — every surface lists its old format, new format,
   and backup file name.

### 3. Composer

The Operator Console (charter §2.1) embeds one rule composer for the
unified grammar, replacing the three existing condition-builder UIs.
`features/rule-criteria/` (already shared by Auto-Tagger and Library
Cleanup) is the seed for the composer, as the evaluator is for the
engine.

## Why this shape

1. **Seed-and-migrate beats clean-room.** The library-cleanup evaluator
   encodes years of edge cases (null handling, *arr field quirks). A
   from-scratch "elegant" engine would rediscover them in production.
2. **Contexts keep domains decoupled.** Queue Cleaner doesn't learn
   about genres; Notifications doesn't learn about tracker health. The
   grammar is shared; the vocabularies are not forcibly merged.
3. **The migration contract is uniform on purpose.** Five different
   migration UXs would each need their own support documentation. One
   contract means one explanation in the release notes and one shape of
   bug report.

## Why not …

- **Unify only Notifications + Library Cleanup** (the minimal breaking
  set). Was the charter draft's recommended option; ratification chose
  full unification (decision #7) because the Operator Console's
  cross-domain composer needs all five vocabularies, and doing three
  now + two later means two migration events for users instead of one.
- **An off-the-shelf rules engine** (json-rules-engine etc.). The
  existing evaluator is already written, tested, and tuned to *arr data
  shapes; a dependency adds a foreign grammar without removing any code
  we own.
- **Keep engines, share only the UI.** A shared composer over five
  serialization formats needs five serializers and five validators —
  the worst of both worlds.

## Consequences

### Positive

- Cross-domain rules become expressible — the capability the Operator
  Console flagship is built around.
- One evaluator to harden, fuzz, and document instead of five.
- Rule-engine bug fixes apply everywhere at once.

### Negative / trade-offs

- Five stored-rule migrations is the largest user-data risk in 3.0.
  The uniform contract and per-surface transactions bound it, but
  3.0-alpha testing must include real 2.x databases with real rules.
- The seed evaluator (82 KB) needs decomposition as it generalizes —
  budgeted as part of the engine work, not deferred.
- Hunting's filters are the furthest in shape from condition trees;
  its migration may legitimately be a thin adapter rather than a full
  rewrite. That is acceptable — the contract is about storage and
  grammar, not internal call paths.

**Amendment note (2026-06-09):** the unified migration gains an explicit
case from ADR-0007's second amendment — **Tautulli-typed conditions**
(`tautulli_last_watched`, `tautulli_watch_count`, `tautulli_watched_by`)
in Library Cleanup (and Auto-Tagger via the shared evaluators) are
removed/retargeted as part of the unified migration rather than in an
ad-hoc A2 pass. Consequence: **Bucket A sequencing is A4 → A2** — the
Tautulli removal rides this migration framework instead of duplicating
it. The migration report per surface must count and list rules whose
conditions referenced Tautulli data so the A2 dialog can disclose them.

**Amendment note 2 (2026-06-09) — eager migration eliminated; 5-point
contract rescoped; A2 re-unblocked:** the grammar design pass
(`docs/design/unified-rule-grammar.md`) found that format unification
needs **no eager row rewrites**: documents version-detect at parse time
(legacy v0 → tiny mapper; `version: 1` → direct), and rules are written
in v1 only on create/edit. Three consequences supersede parts of this
ADR and of amendment 1:

1. **Notifications' stable-tier promise survives unification** — its
   stored rows are untouched until the user edits a rule. The "bundle
   into 3.0 or never" forcing premise in Context no longer applies
   (the unification still ships in 3.0 as planned).
2. **The 5-point migration contract applies to semantic passes only** —
   passes that change what stored rules *mean*. In 3.0 that is exactly
   one pass: the Tautulli-condition retirement. Format conversion needs
   no backup file; untouched rows are the backup.
3. **Bucket A sequencing reverts to A2 → A4** (superseding amendment
   1's ordering): the Tautulli pass operates on v0 documents directly
   and does not need the engine. It establishes the migration-pass
   pattern in miniature; its v0-parsing utilities are reused by A4's
   lazy mappers. Each ordering decision was made on the best evidence
   available at the time; this trail is the record.

A4's acceptance gate is **differential parity testing**: the engine
must produce identical decisions to the legacy evaluators on identical
inputs (fixtures harvested from real rule rows + synthetic edge cases)
before each surface cuts over.

## Follow-ups

- Bucket A design pass: grammar schema (typed fields, operators,
  serialization) — review against all five domains' existing rules
  before freezing. The Tautulli-typed condition kinds are an explicit
  test case for the migration design.
- A `require-migration-on-rule-schema-change` lint (charter §7) once the
  engine stabilizes.
- Dry-run preview infrastructure is shared with the Tautulli wizard's
  patterns (ADR-0007) where practical.
