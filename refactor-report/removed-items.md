# Removed Items Log

## Dead Code Removal

### Status: ✓ Already Completed (Pre-Refactor)

The git history shows recent cleanup has already removed dead code:

1. **apps/web/src/lib/api-client.ts** (deleted)
   - **Why safe**: Replaced by modular api-client/* files
   - **Migration**: Functionality split into domain-specific modules
   - **Verified**: Build and typecheck pass

2. **apps/web/src/hooks/api/useAccountSettings.ts** (deleted)
   - **Why safe**: Functionality merged into useAuth.ts
   - **Migration**: useUpdateAccountMutation now in useAuth
   - **Verified**: Settings page still functional

3. **apps/web/src/hooks/api/useCurrentUser.ts** (deleted)
   - **Why safe**: Functionality merged into useAuth.ts
   - **Migration**: useCurrentUser now exported from useAuth
   - **Verified**: All components using currentUser updated

4. **apps/web/src/hooks/api/useSetup.ts** (deleted)
   - **Why safe**: Functionality merged into useAuth.ts
   - **Migration**: useSetupRequired now in useAuth
   - **Verified**: Setup flow still functional

## Current Refactor - No Deletions Needed

Analysis shows:
- ✓ No orphaned files detected
- ✓ All exports are consumed
- ✓ No unused dependencies found
- ✓ No duplicate functionality identified

The codebase is lean and well-maintained. Previous cleanup efforts were successful.

## Recommendation

No additional deletions required. Focus on:
1. Adding module boundaries (barrel exports)
2. Organizing utilities by domain
3. Enforcing import rules
