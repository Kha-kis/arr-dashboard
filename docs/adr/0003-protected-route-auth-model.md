# ADR 0003: Protected-Route Auth Model

- **Status:** Accepted
- **Date:** 2026-04-13
- **Deciders:** Backend maintainers
- **Supersedes:** —

## Context

Most API routes need an authenticated user. Without a uniform model, each
route would either re-implement the check (drift, missed routes) or rely
on a global hook that gates *all* requests including login itself
(impossible). Reviewers also need a single answer to "is this route
protected, and how do I know?" without reading every handler.

The choice of mechanism — middleware vs. preHandler vs. wrapper function
— shapes how easy it is to get this right and how confidently a new
contributor can plug into the system.

## Decision

Group every protected route under a single Fastify `register(async (api) => …)`
scope in `apps/api/src/bootstrap/protected-routes.ts`. That scope adds
**one `preHandler` hook** that rejects any request without a populated
`request.currentUser`.

```ts
api.addHook("preHandler", async (request, reply) => {
  if (!request.currentUser?.id) {
    return reply.status(401).send({ error: "Authentication required" });
  }
});
```

`request.currentUser` and `request.sessionToken` are populated by the
session-enrichment plugin that runs earlier in the pipeline. The
preHandler simply enforces what the enrichment plugin already attempted.

Public routes (login, OIDC initiate/callback, passkey challenge, the
"setup-required" probe) are registered *outside* this scope and run
without the preHandler.

### What handlers see

Inside any protected handler:

```ts
const userId = request.currentUser!.id;     // safe: preHandler guaranteed it
const token = request.sessionToken;          // present iff the user is logged in
```

The non-null assertion on `currentUser!` is the convention. It's not a
trick: the preHandler returned 401 before this code ran. Hand-checking
inside every handler would add noise without changing behavior.

## Why this shape

1. **One place to read.** A reviewer asks "is route X protected?" by
   confirming X is `register`'d inside `protected-routes.ts`. No reading
   of the route file required.
2. **No middleware framework.** Next.js-style middleware is not used —
   there is nothing in the request path between Fastify and the route.
   Fewer layers, fewer surprises.
3. **Composes with Fastify's plugin model.** Each route module is still
   a `FastifyPluginCallback`; protection is a wrapper, not a runtime
   condition. Test harnesses can register a route plugin without the
   preHandler and inject auth via `setupAuthInjection()` for unit tests.
4. **Single-admin model.** This codebase is single-admin per tenant, so
   "authenticated" *is* "authorized" for product routes. There is no
   role-check layer to integrate with. If that ever changes, the
   `preHandler` is the natural seam to add it (one location).

## Why not …

- **Per-route guards** (`{ preHandler: requireAuth }` per route). Easy
  to forget; reviewers cannot enumerate protected vs. public by
  scanning one file.
- **Global hook on the root app**. Would gate `/api/auth/login` itself —
  the chicken-and-egg problem.
- **Express-style middleware library**. Fastify's hook + plugin scope
  model already supplies the primitives; pulling in middleware machinery
  adds dependency surface for no gain.
- **JWT bearer tokens with stateless verification.** Sessions are
  cookie-backed and DB-tracked because we need server-side
  invalidation (after password change, OIDC unlink, passkey deletion).
  See [`docs/AUTH.md`](../AUTH.md).

## Consequences

### Positive

- One file (`protected-routes.ts`) is the authoritative answer to "what
  is gated."
- The `request.currentUser!.id` pattern is uniform across every handler
  and reads as a contract, not as a non-null gamble.
- Adding a new route domain is a one-liner registration; protection is
  inherited.
- A regression test (`route-auth-enforcement.test.ts`) walks every
  registered route and asserts that calls without a session return 401.

### Negative / trade-offs

- The `!` non-null assertion can look risky to a reviewer who hasn't
  internalized the convention. Mitigated by (a) the centralized
  preHandler, (b) the contract-test that exercises the unauthenticated
  path, (c) this ADR.
- Public routes must be registered *outside* the protected scope. Easy
  to get wrong by reflex (a contributor adds a new "auth" route inside
  `protected-routes.ts` because that's where it looks like auth lives).
  Reviewer cue: anything that must work pre-login goes in `server.ts`,
  not `protected-routes.ts`.
- All-or-nothing: there is no notion of a "partially protected" route.
  If a route needs to behave differently for anonymous vs. authenticated
  callers, the route must be public and check `request.currentUser`
  itself. So far this has not been needed.

## Follow-ups

- If a roles model is ever introduced, extend the preHandler with a
  per-scope role check. Do not introduce route-level role decorators —
  preserve the "one file answers what's protected" property.
- If the public-route list grows, consider a parallel
  `registerPublicRoutes()` boundary so the public surface is also
  enumerable in one place.
