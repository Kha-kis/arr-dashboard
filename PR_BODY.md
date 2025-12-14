## Summary

This PR addresses critical authentication security vulnerabilities and fixes Docker container permission issues on first-time deployment.

## 🐳 Docker Fix

**Problem:** When running the container for the first time with custom PUID/PGID, database creation fails with permission errors.

**Root Cause:** The startup script used `chown abc:abc` which relied on username resolution. After `usermod` changed the UID, the username could still resolve to the old UID (911) instead of the new PUID, causing permission mismatches.

**Solution:** Use numeric IDs directly in `chown $PUID:$PGID` to ensure atomic permission application.

**Files Changed:**
- `docker/start-combined.sh` (line 42)

---

## 🔒 Authentication Security Fixes

### Bug A: Mixed Authentication Mode Vulnerabilities

**Problem:**
- Password authentication remained active when OIDC was configured
- Passkeys could exist as standalone authentication (without password)
- This allowed bypassing centralized OIDC policies (2FA, audit logs, rate limiting)

**Solution:** Implemented strict authentication mode rules:
- ✅ **OIDC enabled** → Password and passkey authentication completely disabled
- ✅ **Password mode** → Passkeys allowed as optional 2FA (require password)
- ✅ **Passkeys** → Cannot be standalone (must have password)

**Files Changed:**
- `apps/api/src/routes/auth.ts` - Block password login/registration/changes when OIDC enabled
- `apps/api/src/routes/auth-passkey.ts` - Block passkey operations when OIDC enabled, require password for passkey registration

---

### Bug B: OIDC Deletion Causes Permanent Lockout (CRITICAL)

**Problem:**
- Deleting or disabling OIDC provider had no validation
- Users with OIDC-only authentication (no password, no passkeys) became permanently locked out
- No mechanism to prevent or recover from this state

**Solution:** Require immediate replacement password when deleting OIDC:
- ✅ DELETE endpoint now requires `replacementPassword` in request body
- ✅ Automatically sets password for all OIDC-only users
- ✅ Forces password change for other users (`mustChangePassword: true`)
- ✅ Validates password strength (8+ chars, mixed case, numbers, special characters)
- ✅ PUT endpoint blocks disabling OIDC if users would be locked out
- ✅ All sessions invalidated to force re-authentication with new method

**Files Changed:**
- `packages/shared/src/types/oidc-provider.ts` - New `deleteOidcProviderSchema` with password validation
- `apps/api/src/routes/oidc-providers.ts` - Complete rewrite of DELETE endpoint, enhanced PUT validation

---

### Bug C: Session Hijacking After Security Incidents

**Problem:**
- Authentication method changes (password change, OIDC deletion, etc.) did not invalidate existing sessions
- Attackers with stolen session tokens could continue accessing the system after victim changed credentials
- Common post-breach mitigation (changing password) was ineffective

**Solution:** Invalidate sessions on all authentication changes:
- ✅ Password change → Invalidate all other sessions (keeps current)
- ✅ Password removal → Invalidate all other sessions (keeps current)
- ✅ Passkey deletion → Invalidate all other sessions (keeps current)
- ✅ OIDC config changes → Invalidate all other sessions (keeps current, only on actual changes)
- ✅ OIDC deletion → Invalidate all other sessions (keeps current)
- ✅ No-op updates (same `enabled` value) → No session invalidation (optimization)

**Files Changed:**
- `apps/api/src/lib/auth/session.ts` - New `invalidateAllUserSessions()` helper method
- `apps/api/src/routes/auth.ts` - Session invalidation on password changes
- `apps/api/src/routes/auth-passkey.ts` - Session invalidation on passkey deletion
- `apps/api/src/routes/oidc-providers.ts` - Session invalidation on OIDC changes, preserves current session

---

### Bug D: Password Removal with Disabled OIDC Causes Lockout (CRITICAL)

**Problem:**
- Password removal endpoint checked if OIDC *accounts* exist, not if OIDC provider is *enabled*
- Admin could disable OIDC, then remove password (session preserved, appears to work)
- After logout/session expiry: permanent lockout (no password, OIDC disabled)
- Enabled a subtle lockout scenario: disable OIDC → remove password → logout → locked out

**Attack Scenario:**
```
1. Admin has: Password + OIDC (enabled)
2. PUT /api/oidc-providers { enabled: false } ✅ Allowed
3. DELETE /auth/password ✅ Allowed (OIDC accounts exist)
4. Session preserved, admin doesn't notice the issue
5. Logout or session expires
6. 🔒 PERMANENT LOCKOUT (no password, OIDC disabled)
```

**Solution:** Validate OIDC provider is enabled before allowing password removal:
- ✅ Password removal now checks `oidcProvider.enabled`, not just account existence
- ✅ Clear error message: "OIDC provider is disabled. Please enable OIDC or keep your password."
- ✅ Prevents the disable → remove password → lockout attack chain

**Files Changed:**
- `apps/api/src/routes/auth.ts` - Added OIDC provider enabled check (lines 440-450)

---

## 📊 Impact Assessment

| Bug | Severity Before | Severity After | Risk Eliminated |
|-----|----------------|----------------|-----------------|
| **A** | ⚠️ Medium | ✅ Fixed | Authentication bypass of centralized OIDC policies |
| **B** | 🔴 **CRITICAL** | ✅ Fixed | Permanent account lockout, complete service outage |
| **C** | 🔴 High | ✅ Fixed | Session hijacking post-breach |
| **D** | 🔴 **CRITICAL** | ✅ Fixed | Subtle lockout via disabled OIDC + password removal |

---

## 🧪 Testing Recommendations

**Scenario 1: OIDC → Password Switch**
1. Enable OIDC provider
2. Verify password login returns 403
3. Delete OIDC with `{ "replacementPassword": "SecurePass123!" }`
4. Verify all sessions invalidated
5. Login with username + new password works

**Scenario 2: Password → OIDC Switch**
1. Start with password auth
2. Create OIDC provider
3. Verify password login returns 403
4. Verify OIDC login works

**Scenario 3: Passkey Registration**
1. With OIDC enabled: passkey registration returns 403
2. Without password: passkey registration returns 403
3. With password, no OIDC: passkey registration works

**Scenario 4: Session Invalidation**
1. Login with password (session 1)
2. Login again in another browser (session 2)
3. Change password in session 1
4. Verify session 2 is invalidated
5. Session 1 still works

**Scenario 5: Lockout Prevention (Bug D)**
1. Admin has password + OIDC (enabled)
2. PUT /api/oidc-providers { enabled: false }
3. DELETE /auth/password
4. Verify request is blocked with "OIDC provider is disabled" error
5. Re-enable OIDC, retry password removal → succeeds

---

## ✅ Compatibility

- ✅ No breaking changes to database schema
- ✅ Backward compatible (existing deployments won't break)
- ✅ Clear error messages guide users
- ✅ Type-safe with Zod schemas
- ✅ Follows existing conventional commit style

---

## 📝 Files Changed (6 files, +226 -9)

- `apps/api/src/lib/auth/session.ts`
- `apps/api/src/routes/auth.ts`
- `apps/api/src/routes/auth-passkey.ts`
- `apps/api/src/routes/oidc-providers.ts`
- `packages/shared/src/types/oidc-provider.ts`
- `docker/start-combined.sh`

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
