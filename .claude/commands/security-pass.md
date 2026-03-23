Perform a focused security audit on: $ARGUMENTS

If no target specified, audit the most recently changed files (`git diff --name-only origin/main..HEAD`).

1. **Auth & authorization**:
   - Are all routes properly protected with preHandler auth check?
   - Is `userId: request.currentUser!.id` included in all Prisma queries for user-owned resources?
   - Are there any routes that should be protected but aren't?

2. **Input validation**:
   - Is `validateRequest()` used for all request body parsing?
   - Are there any `request.body as Type` casts (should be Zod validation)?
   - Are query parameters validated?
   - Are path parameters validated and sanitized?

3. **Data exposure**:
   - Are API keys encrypted before storage (`app.encryptor.encrypt()`)?
   - Could error responses leak internal details (stack traces, file paths, SQL)?
   - Are sensitive fields excluded from API responses?
   - Is incognito mode applied to all new UI data displays?

4. **Trust boundaries**:
   - Are external API responses validated before use?
   - Are user-supplied URLs validated (SSRF risk)?
   - Are there any dangerous defaults that should require explicit opt-in?

5. **Dependencies**:
   - Check `gh api repos/Kha-kis/arr-dashboard/dependabot/alerts --jq '[.[] | select(.state == "open")] | length'`
   - Check `gh api repos/Kha-kis/arr-dashboard/code-scanning/alerts --jq '[.[] | select(.state == "open")] | length'`

6. **Report**: Findings table with Severity (CRITICAL/HIGH/MEDIUM/LOW) | Location | Issue | Recommended Fix

Focus on real vulnerabilities, not theoretical concerns. Do not flag things that are already mitigated by the deployment model (single-admin, self-hosted).
