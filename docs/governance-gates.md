# Governance Gates (Charter §7) — Enforcement Map

Charter §7 commits 3.0 to four governance gates that "become CI gates." They
are **not all ESLint rules** — they can't be. `apps/web` is linted by ESLint
(which hosts custom AST rules via `no-restricted-syntax`), but `apps/api` and
`packages/shared` are linted by **Biome**, which has no custom-AST-rule
mechanism. So API-side gates are enforced as **vitest guards** that fail CI the
same way a lint error would. This document maps each gate to its actual
mechanism so nobody hunts for an ESLint rule that was never the right tool.

| Gate | Target | Mechanism | Where |
|---|---|---|---|
| **L1** `no-inline-Body-without-validateRequest` | `apps/api` routes | vitest guard | `apps/api/src/routes/__tests__/no-inline-body-validation.test.ts` |
| **L2** `require-collector-label-entry` | `apps/api` Pulse collectors | vitest guard | `apps/api/src/routes/__tests__/pulse-collector-label.test.ts` |
| **L3** `require-incognito-on-sensitive-text-props` | `apps/web` rendering | e2e leak gate (CI `e2e` job) + the Bucket B6 sweep | `e2e/incognito-gate.spec.ts` (#533) + `useIncognitoMode` adoption |
| **L4** `no-arbitrary-z-index` | `apps/web` className z-index | ESLint `no-restricted-syntax` | `apps/web/eslint.config.mjs` |

## Notes per gate

- **L1** — File-level: any route file declaring a concrete (non-`unknown`)
  `Body:` generic must call `validateRequest()`. Coarse by design (matches L2);
  `Body: unknown` is exempt; genuine carve-outs add `// l1-guard-exempt: <reason>`.
- **L2** — Every collector in `pulse/collectors.ts` must have an explicit
  `COLLECTOR_LABELS` entry (the humanize fallback is a safety net, not a
  labeling strategy). Shipped in C4 (#524).
- **L3** — Implemented as **behavior** enforcement rather than the charter's
  originally-sketched heuristic ESLint rule on a prop-name allowlist. The
  heuristic was explicitly flagged in §7 as false-positive-prone; the e2e leak
  gate `e2e/incognito-gate.spec.ts` (runs in CI's `e2e` job — asserts no
  sensitive text renders un-anonymized with incognito on) plus the B6
  `useIncognitoMode` sweep enforce the same invariant at the layer that
  actually matters — what the user sees — without the lint noise. Adding the
  heuristic rule later remains an option if regressions slip the e2e net.
- **L4** — Scoped to **3+ digit** arbitrary z-index (`z-[100]`+), which is the
  range that collides with the semantic z-index scale (`z-dropdown`..`z-tooltip`,
  1000–2100 in `globals.css`). Benign local stacking (`z-[1]`, `z-[2]`) is left
  alone; large carve-outs use an `eslint-disable` with a reason. This satisfies
  charter §7 L4's "allowlist the `z-[1]`/`z-[2]` arrows" intent via a value
  threshold rather than a per-file allowlist — simpler to maintain and it doesn't
  false-positive on new benign low-stacking values.
