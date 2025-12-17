# Release Testing Checklist v2.6.2

Pre-release verification checklist for arr-dashboard. Complete all sections before tagging a release.

## Build Verification

```bash
# Run these commands and verify all pass
pnpm run lint          # Should pass (warnings OK)
pnpm run typecheck     # Should pass with no errors
pnpm run build         # Should complete successfully
```

- [ ] `pnpm run lint` passes
- [ ] `pnpm run typecheck` passes
- [ ] `pnpm run build` completes successfully

## Docker Build

```bash
# Build local Docker image
docker build -t arr-dashboard:test .

# Run test container
docker run -d --name arr-test -p 3000:3000 -v ./test-config:/config arr-dashboard:test

# Check logs for startup errors
docker logs arr-test
```

- [ ] Docker build completes without errors
- [ ] Container starts successfully
- [ ] No errors in startup logs
- [ ] Web interface accessible at http://localhost:3000

## Authentication Testing

### Fresh Install
- [ ] Setup page loads on first visit
- [ ] Can create admin account with valid password
- [ ] Redirects to login after account creation
- [ ] Can login with created credentials

### Password Authentication
- [ ] Login with correct credentials succeeds
- [ ] Login with wrong password fails
- [ ] Account locks after 5 failed attempts
- [ ] Lockout message shows remaining time
- [ ] "Remember Me" extends session duration
- [ ] Logout invalidates session

### Session Management
- [ ] Session persists across page refreshes
- [ ] Session expires after configured time (24h default)
- [ ] Password change invalidates other sessions
- [ ] Can view active sessions in settings

### OIDC (if configured)
- [ ] OIDC login button appears when configured
- [ ] Redirect to provider works
- [ ] Callback completes successfully
- [ ] User created/linked correctly

### Passkeys (if configured)
- [ ] Registration flow works
- [ ] Can name passkey after creation
- [ ] Login with passkey succeeds
- [ ] Can delete passkey (if alternative auth exists)
- [ ] Cannot delete last passkey without alternative

## Service Management

### Adding Services
- [ ] "Test Connection" validates before save
- [ ] Sonarr instance adds successfully
- [ ] Radarr instance adds successfully
- [ ] Prowlarr instance adds successfully
- [ ] Invalid URL/API key shows error
- [ ] API key stored encrypted (check DB)

### Service Operations
- [ ] Can edit existing service
- [ ] Can delete service
- [ ] Tags can be assigned
- [ ] Service health indicator works

### Reverse Proxy Handling (New in 2.6.0)
- [ ] 401/403 from proxy handled gracefully
- [ ] Helpful error message displayed

## Dashboard

- [ ] Queue loads from all instances
- [ ] Statistics aggregate correctly
- [ ] Instance links are clickable (New in 2.6.0)
- [ ] Auto-refresh works (30s interval)
- [ ] Error handling for offline instances

## Calendar

- [ ] Shows upcoming releases
- [ ] Entries from multiple instances appear
- [ ] Duplicate entries deduplicated (New in 2.6.0)
- [ ] Unmonitored filter works for both Sonarr/Radarr
- [ ] Date navigation works

## Library

- [ ] Movies list loads
- [ ] Series list loads
- [ ] Search/filter works
- [ ] Pagination works
- [ ] Can toggle monitoring

## Search (Prowlarr)

- [ ] Search form works
- [ ] Results display correctly
- [ ] Can add result to Sonarr/Radarr
- [ ] Multiple indexers searched

## Discover (TMDB)

- [ ] Trending content loads
- [ ] Popular content loads
- [ ] Carousels scroll smoothly
- [ ] No flicker on load (Fixed in 2.6.0)
- [ ] External links work (TMDB, IMDB, TVDB - New in 2.6.0)
- [ ] Caching improves repeat loads (New in 2.6.0)
- [ ] Helpful error when TMDB key missing
- [ ] Can add movie/show to instance

## History

- [ ] Downloads history loads
- [ ] Pagination works
- [ ] Filters work
- [ ] Instance indicators correct

## Statistics

- [ ] Stats load for all instances
- [ ] Tabbed interface works (New in 2.6.0)
- [ ] Charts render correctly
- [ ] Numeric eventType handled (Fixed in 2.6.0)

## TRaSH Guides

### Cache Management
- [ ] Can refresh cache from GitHub
- [ ] Cache status displays correctly

### Templates
- [ ] Can create new template
- [ ] Can clone existing profile
- [ ] Cloned profiles sync correctly (New in 2.6.0)
- [ ] CFs with score 0 not auto-excluded (Fixed in 2.6.0)

### Deployment
- [ ] Preview shows changes accurately
- [ ] Backup created before deployment
- [ ] Deployment succeeds
- [ ] Cutoff ID remapped correctly (Fixed in 2.6.0)
- [ ] Can rollback from backup

## Hunting (New in 2.6.0)

- [ ] Hunt configuration saves
- [ ] Missing content search works
- [ ] Upgrade search works
- [ ] Rate limiting respected
- [ ] Hunt logs display correctly

## Backup & Restore

- [ ] Manual backup creates file
- [ ] Backup downloadable
- [ ] Restore works correctly
- [ ] Automated backups run on schedule

## Settings

### Account Settings
- [ ] Can change username
- [ ] Can change password
- [ ] Can update TMDB API key
- [ ] Password change invalidates sessions

### System Settings
- [ ] Incognito mode works
- [ ] Settings persist after restart

## Incognito Mode

- [ ] Media titles hidden in queue
- [ ] Release names masked
- [ ] Series/movie names replaced with "Linux ISOs"

## Error Handling

- [ ] API unreachable shows helpful message (New in 2.6.0)
- [ ] Network errors handled gracefully
- [ ] Form validation errors display clearly
- [ ] 404 pages render correctly

## PostgreSQL Support (New in 2.6.0)

```bash
# Test with PostgreSQL
docker run -d --name pg-test -e POSTGRES_PASSWORD=test -p 5432:5432 postgres:15

docker run -d --name arr-pg-test \
  -p 3001:3000 \
  -e DATABASE_URL="postgresql://postgres:test@host.docker.internal:5432/arr" \
  arr-dashboard:test
```

- [ ] App starts with PostgreSQL
- [ ] Schema syncs correctly (db push)
- [ ] All features work with PostgreSQL

## Security Checks

- [ ] No sensitive data in browser console
- [ ] API keys not exposed in responses
- [ ] Session cookie is HttpOnly
- [ ] CSRF protection working
- [ ] Rate limiting enforced on auth routes

## Browser Compatibility

- [ ] Chrome/Chromium
- [ ] Firefox
- [ ] Safari (if available)
- [ ] Mobile responsive design

## Cleanup

```bash
# Stop and remove test containers
docker stop arr-test arr-pg-test pg-test 2>/dev/null
docker rm arr-test arr-pg-test pg-test 2>/dev/null
rm -rf ./test-config
```

---

## Sign-off

| Tester | Date | Result |
|--------|------|--------|
| | | |

### Notes
<!-- Add any issues discovered during testing -->


### Version Information

- **Version**: 2.6.0
- **Build Date**:
- **Git Commit**:
- **Last Updated**: 2025-12-16
