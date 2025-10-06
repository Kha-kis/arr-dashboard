# Security & Dependency Update Recommendations

Generated: 2025-10-06

## Critical Issues

### 1. Deprecated Authentication Libraries ⚠️
**Impact**: HIGH - Security updates will no longer be provided

- `lucia@3.2.2` - DEPRECATED
- `oslo@1.2.1` - DEPRECATED

**Action Required**: Migrate to actively maintained authentication solution
- Consider: Auth.js (NextAuth), Clerk, or manual implementation with Passport.js
- Timeline: High priority - should be addressed within 1-2 sprints
- Migration guide: https://lucia-auth.com/blog/lucia-v3-eol

### 2. Known Vulnerability
**Impact**: LOW - Prototype pollution in logging library

- `fast-redact@3.5.0` - Vulnerable to prototype pollution (CVE-2025-XXXXX)
- Fix: Update `pino` from 9.11.0 → 10.0.0 (includes updated fast-redact)

## Major Version Updates Available

### Backend (API)

#### Critical Security Updates
1. **Fastify Security Plugins** (Major version bumps)
   - `@fastify/cookie`: 9.4.0 → 11.0.2
   - `@fastify/cors`: 8.5.0 → 11.1.0
   - `@fastify/helmet`: 11.1.1 → 13.0.2
   - `@fastify/rate-limit`: 8.1.1 → 10.3.0

   **Breaking Changes**: Review plugin APIs before updating

2. **Core Framework**
   - `fastify`: 4.29.1 → 5.6.1
   - `fastify-plugin`: 4.5.1 → 5.1.0

   **Breaking Changes**: Yes - review migration guide at https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/

3. **Logging**
   - `pino`: 9.11.0 → 10.0.0

   **Benefits**: Fixes fast-redact vulnerability

#### Other Backend Updates
- `zod`: 3.25.76 → 4.1.11 (Breaking: schema API changes)
- `@prisma/client`: 6.16.2 → 6.16.3 (Patch - safe to update)
- `prisma`: 6.16.2 → 6.16.3 (Patch - safe to update)
- `dotenv`: 16.6.1 → 17.2.3 (Major - review changes)

### Frontend (Web)

#### Critical Framework Updates
1. **React Ecosystem**
   - `react`: 18.3.1 → 19.2.0
   - `react-dom`: 18.3.1 → 19.2.0
   - `@types/react`: 18.3.24 → 19.2.0
   - `@types/react-dom`: 18.3.7 → 19.2.0

   **Breaking Changes**: Yes - React 19 has significant changes
   **Migration Guide**: https://react.dev/blog/2024/04/25/react-19

2. **Next.js**
   - `next`: 14.2.33 → 15.5.4
   - `eslint-config-next`: 14.2.33 → 15.5.4

   **Breaking Changes**: Yes - Next.js 15 requires React 19
   **Migration Guide**: https://nextjs.org/docs/app/building-your-application/upgrading/version-15

3. **Styling**
   - `tailwindcss`: 3.4.17 → 4.1.14

   **Breaking Changes**: Yes - Tailwind v4 has major changes
   **Migration Guide**: https://tailwindcss.com/docs/v4-beta

#### Other Frontend Updates
- `zod`: 3.25.76 → 4.1.11 (Breaking - coordinate with backend)
- `zustand`: 4.5.7 → 5.0.8 (Major - review changelog)
- `framer-motion`: 11.18.2 → 12.23.22 (Major - review API changes)
- `eslint`: 8.57.1 → 9.37.0 (Major - flat config migration)

### Development Tools
- `typescript`: 5.9.2 → 5.9.3 (Patch - safe to update)
- `@types/node`: 22.18.6 → 24.7.0 (Major - Node 24 types)
- `tsx`: 4.20.5 → 4.20.6 (Patch - safe to update)
- `vitest`: 1.6.1 → 3.2.4 (Major - review breaking changes)

## Recommended Update Strategy

### Phase 1: Immediate (Low Risk)
Update patch versions and fix vulnerability:
```bash
# Update Prisma
pnpm update @prisma/client prisma -r

# Update TypeScript
pnpm update typescript -r

# Update minor dev tools
pnpm update tsx -r
```

### Phase 2: Security Plugins (Medium Risk)
Test in staging environment:
```bash
cd apps/api
pnpm update @fastify/cookie @fastify/cors @fastify/helmet @fastify/rate-limit
```

### Phase 3: Authentication Migration (High Priority)
1. Research replacement for lucia/oslo
2. Implement new auth system in feature branch
3. Test thoroughly in staging
4. Deploy with rollback plan

### Phase 4: Major Framework Updates (High Risk)
**Requires dedicated sprint and thorough testing**

1. **React 19 + Next.js 15** (Frontend)
   - Create migration branch
   - Update React first, test all components
   - Update Next.js, test all routes
   - Regression test entire app

2. **Fastify 5** (Backend)
   - Review breaking changes
   - Update in feature branch
   - Test all API endpoints
   - Load testing recommended

3. **Tailwind 4** (Styling)
   - May require significant CSS refactoring
   - Consider postponing until v4 stable release

4. **Zod 4** (Validation)
   - Update both frontend and backend simultaneously
   - Review all schema definitions
   - Test form validation thoroughly

## Code Quality Issues Remaining

From TheAuditor Biome analysis:

### Remaining Lint Errors: 33 (down from 105)

**Files with errors:**
1. `apps/api/src/routes/search.ts` - Type safety issues
2. `apps/api/src/routes/library.ts` - Type safety issues
3. `apps/api/src/routes/dashboard.ts` - Type safety issues

**Common patterns:**
- Remaining `any` type casts
- Non-null assertions (`!`)
- Unsafe type assertions

**Recommendation**: Continue type safety improvements before major updates

## Testing Requirements

Before deploying any updates:

1. **Unit Tests**: Ensure all pass
2. **Integration Tests**: Test API endpoints
3. **E2E Tests**: Test critical user flows
4. **Performance Tests**: Compare before/after metrics
5. **Security Scan**: Re-run TheAuditor after updates

## Priority Order

1. **HIGH**: Migrate from lucia/oslo (deprecated)
2. **MEDIUM**: Update security plugins (@fastify/*)
3. **MEDIUM**: Fix fast-redact vulnerability (update pino)
4. **LOW**: Update Prisma, TypeScript (safe patches)
5. **PLANNED**: Major framework updates (React 19, Next.js 15, Fastify 5)

## References

- TheAuditor scan results: `.pf/readthis/`
- Vulnerability database: https://github.com/advisories
- Fastify migration: https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/
- React 19 migration: https://react.dev/blog/2024/04/25/react-19
- Next.js 15 migration: https://nextjs.org/docs/app/building-your-application/upgrading/version-15
