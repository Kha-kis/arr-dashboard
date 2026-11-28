# Dependency backports

## braces 3.0.3: bounded structural recursion

`braces@3.0.3.patch` is a local mitigation for the recursive stack-exhaustion
behavior tracked by GHSA-vfj7-8cjw-p6xm. It is not an upstream patched release,
an audit suppression, or a claim to prevent every resource-exhaustion attack.
The original package version, dependency ranges and MIT license are retained.

The patch rejects structural depth above a fixed internal limit of 128 before
recursive processing. This covers parsed strings, direct syntax trees, parent
chains and nested arrays. Rejection is a `RangeError` with the constant code
`ERR_BRACES_MAX_DEPTH`; options cannot raise or disable the limit. Existing
ordinary matching/expansion and default length/range limits remain unchanged.
Very deeply nested inputs are intentionally no longer accepted. The parser
reserves room for leaf nodes, so its container count is not the same as the
direct-tree child-edge depth.

Width, Cartesian expansion, total CPU/heap use, shared-subgraph revisits and
hostile JavaScript getters/iterators/callbacks are outside this bounded change.
Do not describe this as a general resource sandbox or zero-advisory result.

The exact-version pnpm patch entry, locked patch hash and fatal patch-failure
settings make missing, changed, unused or unapplyable patches visible during
installation. Docker copies the patch before installing dependencies.
`pnpm run test:dependency-patches`, also run first by `pnpm run test`, exercises
the real Next lint dependency chain rather than a separate direct dependency.
It covers controlled refusals and ordinary output compatibility.

When upstream provides a suitable correction, replace this backport only after
the affected dependency chain, regressions and caller compatibility are checked.
Keep the advisory status distinct from verified local mitigation evidence.
