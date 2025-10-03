# Risky Removals & Archived Items

## Status: None Required

### Analysis Results

After thorough analysis of the codebase:

✓ **No risky removals identified**
- All files are actively used
- No ambiguous dynamic imports found
- No string-based route references to removed files
- Build and runtime verification passed

✓ **No items archived**
- No files moved to archive/ directory
- All code is actively maintained
- Recent cleanup was done safely with proper migration

### Conservative Approach Taken

The refactor followed these safety principles:
1. **Verify before delete**: All removed files (from previous cleanup) were verified safe
2. **Prefer deprecation**: No cases required deprecation warnings
3. **Archive unclear cases**: No unclear cases found
4. **Document all changes**: Git history shows clear migration path

### Previous Cleanup (Pre-Refactor) - All Safe ✓

Files deleted in recent commits:
- api-client.ts → Split into modular clients (safe, verified)
- useAccountSettings.ts → Merged into useAuth (safe, verified)
- useCurrentUser.ts → Merged into useAuth (safe, verified)
- useSetup.ts → Merged into useAuth (safe, verified)

All deletions followed proper migration:
1. Functionality preserved
2. Consumers updated
3. Tests/build verified
4. No runtime errors

## Recommendation

Continue following conservative removal practices:
1. Always verify imports before deleting
2. Run full build + typecheck after removals
3. Document migration path in commit messages
4. Keep git history clean for easy rollback if needed
