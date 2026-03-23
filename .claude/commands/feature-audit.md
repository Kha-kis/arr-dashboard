Audit the feature or module at: $ARGUMENTS

1. **Identify scope**: Determine the feature's files (components, hooks, API routes, types, tests). List them.

2. **Check completeness**:
   - Are all CRUD operations implemented and tested?
   - Is incognito mode applied to all sensitive data displays?
   - Are query keys centralized in `lib/query-keys.ts`?
   - Are polling intervals using `POLLING_*` constants?
   - Is error handling consistent (proper status codes, user-facing messages)?
   - Are mutations invalidating the correct query keys?

3. **Check quality**:
   - Is business logic in hooks/utilities, not in component bodies?
   - Is there duplicated logic that should be extracted?
   - Are there inline `useQuery`/`useMutation` calls that should be in `hooks/api/`?
   - Are there hardcoded strings that should be constants?

4. **Check test coverage**:
   - Do critical paths have unit tests?
   - Are edge cases handled (empty data, errors, loading states)?

5. **Produce an action plan**:
   - List concrete improvements ranked by value
   - Separate quick wins from larger efforts
   - Do NOT implement — just report findings and recommended next steps

Output format: Findings table (Severity | Location | Issue | Suggested Fix), then prioritized action plan.
