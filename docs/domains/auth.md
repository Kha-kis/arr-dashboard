# Domain: Auth

Operating manual for the authentication subsystem. For protocol-level deep
dives (Argon2 params, OIDC PKCE flow, WebAuthn counter rules, encryption
internals) see [`docs/AUTH.md`](../AUTH.md). This doc covers **where to put
things, what to never break, and what fails in the wild**.

## Purpose

Establish that an HTTP request belongs to a known user, decide whether the
request is allowed, and protect the credentials needed to do that on every
subsequent request. Also: keep the secrets that other domains rely on
(`app.encryptor` for service credentials, `app.sessionService` for cookies)
behind a stable interface.

## Key files

| Concern | File |
|---|---|
| Password login + setup + lockout | `apps/api/src/routes/auth.ts` |
| OIDC initiate / callback / linking | `apps/api/src/routes/auth-oidc.ts` |
| Passkey register / login / list / delete | `apps/api/src/routes/auth-passkey.ts` |
| OIDC provider config (singleton) | `apps/api/src/routes/oidc-providers.ts` |
| Session create / invalidate / cookie | `apps/api/src/lib/auth/session.ts` |
| Argon2id hashing | `apps/api/src/lib/auth/password.ts` |
| AES-256-GCM encryption | `apps/api/src/lib/auth/encryption.ts` |
| WebAuthn wrapper (@simplewebauthn) | `apps/api/src/lib/auth/passkey-service.ts` |
| Auto-generated secrets | `apps/api/src/lib/auth/secret-manager.ts` |
| Protected-route preHandler | `apps/api/src/bootstrap/protected-routes.ts` |
| Password schema (shared) | `packages/shared/src/types/password.ts` |

Frontend session UI lives under
`apps/web/src/features/settings/components/sessions-section.tsx` and the
auth flow pages are in `apps/web/app/login/`, `apps/web/app/setup/`.

## Invariants

These are load-bearing. Breaking any of them is a security regression.

1. **Every protected route runs the `protected-routes` preHandler.** It is
   what populates `request.currentUser` and `request.sessionToken`. If a
   handler reads `request.currentUser!.id` without that preHandler having
   run, you have an unauthenticated route claiming to be authenticated.
   See ADR-0003.
2. **Every user-owned query filters by `userId: request.currentUser!.id`.**
   This is the single defense against id-guessing across users in a
   single-admin-per-tenant model. The reviewer checklist exists for this
   reason — it is invisible at the type level.
3. **All secret material is encrypted at rest** with `app.encryptor.encrypt()`
   and stored as `{ value, iv }` columns. No plaintext API keys, OIDC client
   secrets, or webhook tokens in the DB. Ever.
4. **Credential changes invalidate other sessions.** After password change,
   OIDC unlink, or passkey deletion, call
   `app.sessionService.invalidateAllUserSessions(userId, exceptToken)`.
   Failing to do this leaves a stolen-cookie attacker logged in after the
   user "rotated."
5. **Passkeys require a password as prerequisite, and the last passkey can
   only be deleted if another method exists.** The user must always have a
   working way back in.
6. **Counter-on-replay**: WebAuthn responses with non-incrementing counters
   are rejected. This is enforced in `passkey-service.ts`; do not weaken it.
7. **Cookies are HttpOnly + SameSite=Lax always.** The `Secure` flag is the
   only one that varies with environment (`COOKIE_SECURE ?? TRUST_PROXY`).

## Major integration points

- **`app.sessionService`** — every domain that needs to invalidate or read
  sessions goes through this Fastify decoration.
- **`app.encryptor`** — used by services, backups, OIDC config, webhook
  config, and anywhere else credentials live in the DB.
- **`request.currentUser`** — the dependency contract every protected route
  takes from this domain.
- **Security Posture (`/system/security-posture`)** consumes auth state
  (OIDC enabled, passkey count, password user count) to evaluate hardening
  warnings. See [`docs/domains/system.md`](system.md).

## Common failure modes / operational notes

- **Account lockout** — 5 failed logins ⇒ 15-minute lock. Cleared on
  successful login. Visible to operators only via DB inspection right now.
- **OIDC discovery flake** — provider metadata fetch can time out. The
  callback handler returns 502; the user re-clicks "Sign in with OIDC."
  Do not auto-retry server-side, it amplifies provider downtime.
- **Passkey counter regressions** — happens when a user restores from a
  backup of an older OS profile. The fix is to delete and re-enroll the
  passkey, not to relax the counter check.
- **Session cookie not sent over HTTP** — happens when `COOKIE_SECURE=true`
  but the operator is reaching the app over plain HTTP without a TLS-
  terminating proxy. Caught by the Security Posture check
  (`secure-cookies` ⇒ misconfigured).
- **`secrets.json` rotation** — rotating `ENCRYPTION_KEY` invalidates every
  encrypted blob in the DB (service API keys, OIDC secret, webhook
  secrets). There is no rotation tooling; treat the key as long-lived.

## Where to add new code

| Change | Goes in |
|---|---|
| New password rule | `packages/shared/src/types/password.ts` (Zod schema) |
| New auth method (e.g., magic link) | new `apps/api/src/routes/auth-<method>.ts` + helper in `apps/api/src/lib/auth/` + Posture check in `lib/security/security-posture.ts` |
| Tightening lockout / rate-limit | `apps/api/src/routes/auth.ts` (constants at top of file) |
| Surfacing auth state in UI | extend `SecurityPostureSection` in `apps/web/src/features/settings/components/security-posture-section.tsx` (don't create parallel surface) |
| New session-invalidation trigger | call `app.sessionService.invalidateAllUserSessions()` from the route that performs the credential change |
| New encrypted DB column | add `value` + `iv` columns; encrypt via `app.encryptor.encrypt()`; never store plaintext fallback |

## When to update this doc

- A new auth method is added, or an existing one is removed.
- An invariant in the list above changes (severity: also write an ADR).
- Session-cookie defaults change (`SameSite`, `HttpOnly`, `Secure`).
- A new shared-encryption consumer is introduced.

Operational details (timeouts, lockout numbers, hashing params) belong in
[`docs/AUTH.md`](../AUTH.md) — not here.
