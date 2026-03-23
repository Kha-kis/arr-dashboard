---
name: auth-reviewer
description: Specialized knowledge for reviewing authentication changes — OIDC flows, session management, encryption, and trust boundaries
type: skill
---

# Auth Reviewer Knowledge

Load this skill when reviewing or modifying authentication, authorization, OIDC, passkeys, or session management.

## Auth Architecture

Three mutually exclusive auth methods (during setup):
- **Password**: Argon2id (memory 19456 KiB, iterations 2, parallelism 1). Account lockout after 5 failures for 15 minutes.
- **OIDC**: oauth4webapi library. PKCE + state + nonce. Supports Authentik, Authelia, Keycloak, etc.
- **Passkeys**: @simplewebauthn/server v13+. Requires password as prerequisite. Disabled when OIDC enabled.

## OIDC Issuer Handling (Critical — #208)

`resolveCanonicalIssuer()` in `lib/auth/oidc-utils.ts`:
- Fetches the provider's discovery document to get the canonical `issuer` value
- Tries both trailing-slash variants for discovery URL construction
- Returns structured result with `source` ("discovery" or "fallback") and optional `warning`
- Callers MUST log warnings — discovery failures silently fall back otherwise

Self-healing in `OIDCProvider.discoverAuthServer()`:
- If `processDiscoveryResponse` fails with issuer mismatch, extracts canonical issuer from the response and retries once
- Handles existing stored issuers that were normalized with the old trailing-slash-stripping behavior

**Key rule**: oauth4webapi performs strict string comparison per RFC 8414 §2. The stored issuer must exactly match the discovery document's `issuer` field.

## Session Management

- Tokens: 32-byte random → SHA-256 hash → stored in DB
- Cookie: `arr_session`, HTTP-only, SameSite=lax, secure=false (allows HTTP for local networks)
- `request.currentUser` populated by preHandler hook
- After credential changes: `invalidateAllUserSessions(userId, exceptToken)` — keeps current session, kills all others

## Trust Boundaries

- All API keys encrypted at rest (AES-256-GCM) via `app.encryptor`
- `secrets.json` auto-generated if not present — contains `ENCRYPTION_KEY` and `SESSION_COOKIE_SECRET`
- Route protection: preHandler hook checks `request.currentUser?.id`. Every protected route plugin must add this.
- OIDC setup endpoint (`/auth/oidc/setup`) is unauthenticated (first-run only) — has SSRF risk surface via `resolveCanonicalIssuer` fetching user-supplied URLs

## Review Checklist for Auth Changes

1. Does the change add/modify routes? → Verify preHandler auth hook is present
2. Does it touch Prisma queries? → Verify `userId` ownership filter
3. Does it handle credentials? → Verify session invalidation after changes
4. Does it accept URLs from users? → Verify URL validation, check for SSRF
5. Does it touch OIDC? → Test with trailing-slash and non-trailing-slash issuers
6. Does it add new API keys? → Verify encryption before storage
7. Does it modify error responses? → Verify no internal details leaked (stack traces, file paths)
