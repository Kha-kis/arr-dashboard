# Authentication System

> Reference documentation extracted from CLAUDE.md for detailed deep dives into the authentication system.

## Overview

Three authentication methods (configured during setup):

| Method | Requires | Notes |
|--------|----------|-------|
| **Password** | Username + password | Can be removed if OIDC is configured |
| **OIDC** | External provider (Keycloak, Authentik, etc.) | Can coexist with password |
| **Passkeys** | Password as prerequisite | WebAuthn/FIDO2 hardware keys |

**Key Files:**
- `apps/api/src/routes/auth.ts` - Password auth
- `apps/api/src/routes/auth-oidc.ts` - OIDC flow
- `apps/api/src/routes/auth-passkey.ts` - WebAuthn
- `apps/api/src/lib/auth/session.ts` - Session management
- `apps/api/src/lib/auth/password.ts` - Argon2id hashing
- `apps/api/src/lib/auth/encryption.ts` - AES-256-GCM
- `apps/api/src/lib/auth/passkey-service.ts` - WebAuthn wrapper

## Session Management

**Flow:**
1. Login -> Generate 32-byte token -> SHA-256 hash -> Store in DB
2. Signed HTTP-only cookie sent to client (`arr_session`)
3. Each request: Extract cookie -> Hash -> Lookup -> Validate expiry
4. `request.currentUser` populated by preHandler hook

**Cookie Configuration:**
```typescript
{
  httpOnly: true,
  sameSite: 'lax',      // CSRF protection
  secure: auto,          // Auto-detected: true when TRUST_PROXY=true, false for direct access
  maxAge: rememberMe ? 30 days : SESSION_TTL_HOURS
}
```

The `secure` flag is auto-detected: `COOKIE_SECURE=true` forces HTTPS-only, `COOKIE_SECURE=false` forces HTTP, and when unset it follows `TRUST_PROXY` (proxy implies HTTPS termination).

**Session Operations** (`apps/api/src/lib/auth/session.ts`):
```typescript
// Create session
const session = await app.sessionService.createSession(userId, rememberMe);
app.sessionService.attachCookie(reply, session.token, rememberMe);

// Invalidate
await app.sessionService.invalidateSession(token);
await app.sessionService.invalidateAllUserSessions(userId, exceptToken?);
```

## Password Authentication

**Hashing** (Argon2id):
- Memory: 19,456 KiB
- Iterations: 2
- Parallelism: 1

**Account Lockout:**
- 5 failed attempts -> 15-minute lockout
- 200ms delay on failed login (timing attack mitigation)
- Reset on successful login

**Validation** (`packages/shared/src/types/password.ts`):
```typescript
export const passwordSchemaStrict = z.string()
  .min(8).max(128)
  .regex(/[a-z]/, "lowercase required")
  .regex(/[A-Z]/, "uppercase required")
  .regex(/[0-9]/, "number required")
  .regex(/[^a-zA-Z0-9]/, "special char required");
```

## OIDC Authentication

**Library**: oauth4webapi

**Flow:**
1. `POST /auth/oidc/login` -> Generate state, nonce, PKCE verifier
2. Redirect to provider authorization URL
3. `GET /auth/oidc/callback` -> Validate state, exchange code
4. Verify ID token nonce, get user info
5. Create/link OIDCAccount, create session

**Security:**
- PKCE (Proof Key for Code Exchange)
- State parameter (CSRF protection)
- Nonce validation (replay attack prevention)
- Subject claim consistency check

**Configuration** (`apps/api/src/routes/oidc-providers.ts`):
- Singleton pattern (only one provider)
- Client secret encrypted at rest
- Auto-generated redirect URI

## Passkey Authentication

**Library**: @simplewebauthn/server v13+

**Constraints:**
- Requires password as prerequisite
- Disabled when OIDC enabled
- Cannot delete last passkey without alternative auth

**Registration Flow:**
1. `POST /auth/passkey/register/options` -> Generate challenge (5min expiry)
2. Client creates credential via WebAuthn API
3. `POST /auth/passkey/register/verify` -> Verify, store credential

**Login Flow:**
1. `POST /auth/passkey/login/options` -> Generate challenge + temp sessionId
2. Client authenticates via WebAuthn API
3. `POST /auth/passkey/login/verify` -> Verify, validate counter, create session

**Counter Validation:**
```typescript
// Prevents replay attacks
if (credential.counter > 0 && response.counter <= credential.counter) {
  throw new Error("Counter not incremented - possible replay attack");
}
```

## Security Features

### Encryption

`apps/api/src/lib/auth/encryption.ts`:

```typescript
// Encrypt
const { value, iv } = app.encryptor.encrypt(plaintext);
// Store both value and iv in database

// Decrypt
const plaintext = app.encryptor.decrypt({ value, iv });
```

### Auto-Generated Secrets

`apps/api/src/lib/auth/secret-manager.ts`:

- `ENCRYPTION_KEY`: 32 bytes hex
- `SESSION_COOKIE_SECRET`: 32 bytes hex
- Persisted to `/config/secrets.json` (Docker) or `./secrets.json` (dev)

### Session Invalidation Pattern

```typescript
// After credential changes, invalidate other sessions
if (request.sessionToken) {
  await app.sessionService.invalidateAllUserSessions(
    request.currentUser.id,
    request.sessionToken  // Keep current session
  );
} else {
  // Fallback: invalidate all sessions
  await app.sessionService.invalidateAllUserSessions(request.currentUser.id);
}
```
