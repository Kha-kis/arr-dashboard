Perform a trust and UX correctness audit on: $ARGUMENTS

If no target specified, audit files changed on the current branch (`git diff --name-only origin/main..HEAD`).

This audit focuses on issues that are NOT security vulnerabilities but erode user trust: misleading data, missing privacy masking, overclaiming signals, or broken navigation. These are the issues that make users doubt whether the feature is working correctly.

1. **Privacy / Incognito coverage**:
   - List every component that renders instance names, titles, URLs, or usernames
   - For each: does it use `useIncognitoMode()` + the appropriate anonymizer (`getLinuxInstanceName`, `anonymizeHealthMessage`, etc.)?
   - Check: if data comes from the API with embedded instance names (e.g., Pulse titles), is the client-side masking applied to the full text?

2. **Ownership scoping**:
   - List every Prisma query in new backend code
   - For each: does it filter by `userId` (directly or via `instance: { userId }` relation)?
   - Check: are there any queries that access global singletons (like `integrationHealth`)? If so, do they contain user-specific data?

3. **Signal accuracy / overclaiming**:
   - For each user-facing count, message, or status indicator: is the underlying data precise, or is it a proxy?
   - If a proxy: would a user be misled? (e.g., "Library insights available" when there are zero actual insights)
   - Check: does every signal have a clear "why now" (time-sensitive or state-change) rather than "always true"?

4. **Service-availability gating**:
   - For each signal/insight that depends on optional services (Plex, Seerr, Tautulli): is there a guard that prevents misleading items when the service isn't configured?
   - Check: would a user with only Sonarr see any items about Plex/Seerr/Tautulli?

5. **Action link correctness**:
   - List every action link, deep link, or navigation target in the feature
   - For each: does the destination page exist? Does it show the relevant data? Does the link include any required query params?

6. **Duplicate surface risk**:
   - For each signal/data point: where else in the app does this same information appear?
   - Classify: unique synthesis (good), acceptable overlap (fine), or pure duplicate (needs justification)

7. **Report**: Findings table with columns:
   - Category (privacy | ownership | accuracy | gating | navigation | overlap)
   - Severity (must-fix | should-fix | acceptable)
   - Location (file:line)
   - Issue
   - Recommended fix
