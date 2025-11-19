# Migration Notes for ARR Dashboard

## Version 2.x - Single OIDC Provider Migration

### ⚠️ BREAKING CHANGE: Single OIDC Provider Per Installation

**Migration:** `20251118232139_simplify_oidc_single_provider`

The application now supports **only one OIDC provider per installation** (instead of multiple). This simplifies configuration and aligns with the single-admin architecture.

### What This Migration Does

1. **Removes duplicate OIDCAccount entries**
   - If the same user (`providerUserId`/`sub` claim) is linked to multiple providers, only the most recently created account is kept
   - Other accounts are automatically deleted

2. **Removes extra OIDC providers**
   - If multiple OIDC providers are configured, only the most recently created provider is kept
   - Other providers are automatically deleted

3. **Backfills missing redirectUri values**
   - If any provider has a NULL `redirectUri`, it will be backfilled with `{issuer}/auth/oidc/callback`
   - The `redirectUri` field is now required in the database

### Pre-Migration Checklist

**If you have a multi-provider setup, please review before upgrading:**

1. **Check for duplicate providers:**
   ```sql
   SELECT COUNT(*) FROM oidc_providers;
   ```
   If count > 1, only the most recent will be kept.

2. **Check for duplicate user accounts:**
   ```sql
   SELECT providerUserId, COUNT(*) as count
   FROM oidc_accounts
   GROUP BY providerUserId
   HAVING count > 1;
   ```
   If any duplicates exist, only the most recent per `providerUserId` will be kept.

3. **Check for NULL redirectUri:**
   ```sql
   SELECT id, displayName, issuer FROM oidc_providers WHERE redirectUri IS NULL;
   ```
   NULL values will be backfilled as `{issuer}/auth/oidc/callback`.

### Post-Migration

After upgrading:

1. Verify your OIDC provider configuration in Settings
2. Test OIDC login flow
3. If the wrong provider was kept, delete it and reconfigure the correct one

### Manual Cleanup (Optional)

If you want to manually control which provider/accounts are kept:

```sql
-- Keep specific provider (replace YOUR_PROVIDER_ID)
DELETE FROM oidc_providers WHERE id != 'YOUR_PROVIDER_ID';

-- Keep specific accounts per user
DELETE FROM oidc_accounts
WHERE id NOT IN (
  SELECT id FROM oidc_accounts WHERE provider = 'YOUR_PREFERRED_PROVIDER'
);
```

Run these **BEFORE** applying the migration.

### Technical Details

**Schema Changes:**
- `OIDCProvider.type` column removed (no longer differentiating provider types)
- `OIDCProvider.redirectUri` is now required (non-NULL)
- `OIDCAccount.provider` column removed (no longer tracking which provider was used)
- `OIDCAccount.providerUserId` now has a unique constraint (one user per installation)

**API Changes:**
- `/api/oidc-providers` returns a single provider object instead of an array
- POST `/api/oidc-providers` checks for existing provider and returns 409 if one exists
- Settings UI updated to manage a single provider instead of multiple

### Rollback

If you need to rollback this migration:

```bash
cd apps/api
npx prisma migrate resolve --rolled-back 20251118232139_simplify_oidc_single_provider
```

Then manually restore the previous schema. **Warning:** This may cause data loss.

---

**For questions or issues, please file an issue at:** https://github.com/khak1s/arr-dashboard/issues
