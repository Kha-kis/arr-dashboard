# Plex History Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix issues #673 and #675 so Plex cache refresh, episode cache refresh,
and Library Cleanup can consume a complete history snapshot on Plex
`1.43.3.10861-07dfddaeb` without weakening pagination safety.

**Architecture:** Send the Plex-compatible single history sort key
`viewedAt:desc`. Continue to require stable `historyKey` values, exact pagination
metadata, duplicate rejection, total-size consistency, and a complete second
snapshot comparison before publishing safety-relevant cache data.

**Tech Stack:** TypeScript, Plex HTTP API, Fastify logging, Zod, Vitest, Docker
Compose, SQLite, and PostgreSQL.

## Global Constraints

- Target `main` first because both reports affect v2.23.0 stable users.
- This pull request changes only Plex history request compatibility and its
  tests. Do not include TRaSH Auto Sync, OIDC formatting, dependency updates, or
  unrelated Plex endpoint cleanup.
- Live verification against the user's Plex server is read-only. Do not delete,
  refresh a media section, change metadata, or expose a Plex token.
- A complete history inventory remains mandatory for safety-relevant cache
  publication. Compatibility failure must never become permission to publish a
  partial snapshot.
- Use finding IDs `PLEX-675-NNN`. One regression discovery pass and one
  data-safety discovery pass precede the frozen candidate.

---

### Task 1: Reproduce the compound-sort failure in a focused client test

**Files:**

- Modify: `apps/api/src/lib/plex/__tests__/plex-client-completeness.test.ts`
- Read: `apps/api/src/lib/plex/plex-client.ts:405-510`

**Interfaces:**

- Consumes: `PlexClient.getHistory({ maxResults, requireComplete })`.
- Produces: a failing regression that accepts only `sort=viewedAt:desc` and
  returns HTTP 400 for the current comma-separated sort value.

- [ ] **Step 1: Create a stable 201-row history fixture**

  Add a local helper that produces unique stable history rows, including rows
  sharing the same `viewedAt` value:

  ```ts
  function historyItem(index: number) {
    return {
      historyKey: `/status/sessions/history/${index}`,
      ratingKey: `movie-${index}`,
      title: `Movie ${index}`,
      type: "movie",
      viewedAt: 1_700_000_000,
      accountID: 1,
    };
  }
  ```

- [ ] **Step 2: Write the reported compatibility regression**

  Add a test whose fetch stub returns HTTP 400 whenever the `sort` query value
  contains a comma and returns two valid pages for `viewedAt:desc`:

  ```ts
  it("uses a Plex-compatible single sort key for complete history", async () => {
    const history = Array.from({ length: 201 }, (_, index) => historyItem(index));
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.searchParams.get("sort") !== "viewedAt:desc") {
        return new Response(null, { status: 400, statusText: "Bad Request" });
      }
      const offset = Number(url.searchParams.get("X-Plex-Container-Start") ?? "0");
      const page = history.slice(offset, offset + 200);
      return response({ offset, size: page.length, totalSize: history.length, Metadata: page });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new PlexClient("http://plex.test", "token", log);
    await expect(
      client.getHistory({ maxResults: 100_000, requireComplete: true }),
    ).resolves.toHaveLength(201);
  });
  ```

- [ ] **Step 3: Verify the regression fails before implementation**

  Run:

  ```bash
  pnpm --filter @arr/api test -- src/lib/plex/__tests__/plex-client-completeness.test.ts
  ```

  Expected: the new test fails with `Plex API error: HTTP 400 Bad Request`
  because the request contains `viewedAt:desc,historyKey:desc`.

- [ ] **Step 4: Record the reproduction**

  Create finding `PLEX-675-001` in the branch notes or pull-request finding
  ledger with the exact current URL, mocked Plex response, and affected callers:
  `refreshPlexCache`, `refreshPleEpisodeCache`, and Library Cleanup Plex
  prefetch.

### Task 2: Use the compatible sort without weakening completeness checks

**Files:**

- Modify: `apps/api/src/lib/plex/plex-client.ts:414-487`
- Test: `apps/api/src/lib/plex/__tests__/plex-client-completeness.test.ts`

**Interfaces:**

- Consumes: Plex history pagination parameters.
- Produces: history requests with the exact sort value `viewedAt:desc`; all
  existing safety checks remain active.

- [ ] **Step 1: Define the request sort once**

  Add beside the other Plex safety constants:

  ```ts
  const HISTORY_SORT = "viewedAt:desc";
  ```

- [ ] **Step 2: Replace the compound query value**

  Build the history path with the constant while leaving page offsets, page
  sizes, total validation, duplicate checks, and stable-row requirements
  unchanged:

  ```ts
  `/status/sessions/history/all?sort=${HISTORY_SORT}&X-Plex-Container-Start=${offset}&X-Plex-Container-Size=${take}`
  ```

- [ ] **Step 3: Verify the new regression passes**

  Run:

  ```bash
  pnpm --filter @arr/api test -- src/lib/plex/__tests__/plex-client-completeness.test.ts
  ```

  Expected: the compatibility regression and all existing completeness tests
  pass.

- [ ] **Step 4: Commit the red-green slice**

  ```bash
  git add apps/api/src/lib/plex/plex-client.ts apps/api/src/lib/plex/__tests__/plex-client-completeness.test.ts
  git commit -m "fix(plex): use compatible history sorting"
  ```

### Task 3: Prove same-second pagination still fails closed

**Files:**

- Modify: `apps/api/src/lib/plex/__tests__/plex-client-completeness.test.ts`

**Interfaces:**

- Consumes: single-key history ordering and stable history identities.
- Produces: regression evidence that equal timestamps cannot silently create a
  partial published inventory.

- [ ] **Step 1: Assert every page uses the compatible sort**

  Extend the 201-row same-second test to inspect every fetch call:

  ```ts
  for (const [input] of fetchMock.mock.calls) {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    expect(url.searchParams.get("sort")).toBe("viewedAt:desc");
  }
  ```

- [ ] **Step 2: Preserve duplicate-page rejection**

  Keep the existing repeated-page test and make its rows share one `viewedAt`
  value. It must still reject with `duplicate row while paging`.

- [ ] **Step 3: Preserve second-snapshot drift rejection**

  Keep the existing equal-count and middle-page churn tests. Both must still
  reject before cache publication when the stable history signatures differ.

- [ ] **Step 4: Run the client safety suite**

  ```bash
  pnpm --filter @arr/api test -- src/lib/plex/__tests__/plex-client-completeness.test.ts src/lib/plex/__tests__/plex-client-media-parts.test.ts
  ```

  Expected: all tests pass with no skipped new regression.

- [ ] **Step 5: Commit the safety assertions**

  ```bash
  git add apps/api/src/lib/plex/__tests__/plex-client-completeness.test.ts
  git commit -m "test(plex): retain complete history pagination"
  ```

### Task 4: Verify every affected cache consumer

**Files:**

- Verify: `apps/api/src/lib/plex/plex-cache-refresher.ts`
- Verify: `apps/api/src/lib/plex/plex-episode-cache-refresher.ts`
- Verify: `apps/api/src/lib/library-cleanup/cleanup-executor.ts`
- Test: `apps/api/src/lib/plex/__tests__/plex-cache-refresher.test.ts`
- Test: `apps/api/src/lib/plex/plex-episode-cache-refresher.test.ts`

**Interfaces:**

- Consumes: corrected `PlexClient.getHistory()` and
  `PlexClient.verifyHistorySnapshot()` behavior.
- Produces: unchanged atomic cache publication and Library Cleanup fail-closed
  semantics.

- [ ] **Step 1: Run both cache refresher suites**

  ```bash
  pnpm --filter @arr/api test -- src/lib/plex/__tests__/plex-cache-refresher.test.ts src/lib/plex/plex-episode-cache-refresher.test.ts
  ```

  Expected: both suites pass, including incomplete-history and verification
  failure cases.

- [ ] **Step 2: Run the Plex-dependent Library Cleanup suites**

  ```bash
  pnpm --filter @arr/api test -- src/lib/library-cleanup/__tests__/prefetch-plex-data.test.ts src/lib/library-cleanup/__tests__/shared-plex-safety.test.ts src/lib/library-cleanup/__tests__/shared-plex-sonarr-safety.test.ts
  ```

  Expected: complete evidence remains usable and incomplete evidence remains
  blocked.

### Task 5: Live-verify the reporter scenario read-only

**Files:**

- No production files change.
- Evidence output must exclude tokens, usernames, media titles, and server URLs.

**Interfaces:**

- Consumes: the user's configured Plex instance and the disposable Plex harness.
- Produces: before-and-after HTTP, cache, episode-cache, and Library Cleanup
  evidence for the exact reported scenario.

- [ ] **Step 1: Capture the failing baseline**

  On the unmodified base or published v2.23.0 image, trigger the existing Plex
  cache refresh action. Record Plex version, HTTP 400 status, and the sanitized
  history path. Do not print or copy the Plex token.

- [ ] **Step 2: Run the candidate against the same Plex server**

  Trigger both Plex cache refresh and Plex episode cache refresh. Confirm both
  complete without an HTTP 400 and publish fresh cache timestamps.

- [ ] **Step 3: Run a Library Cleanup dry run**

  Use a rule that depends on Plex watch evidence. Confirm Plex prefetch is
  complete and the dry run remains side-effect free.

- [ ] **Step 4: Exercise the disposable Plex harness**

  Run the existing Library Cleanup policy and retained-identity scenarios on
  the candidate image. Confirm the single-sort change does not alter retained
  Plex identity or safety outcomes.

### Task 6: Apply the bounded review and merge gates

**Files:**

- Update: `docs/library-cleanup-gauntlet.md` only if the live evidence changes a
  recorded Plex compatibility status.

**Interfaces:**

- Consumes: frozen diff and finding ledger.
- Produces: one merge-ready Plex pull request with bounded review evidence.

- [ ] **Step 1: Run one regression discovery pass**

  Delegate the frozen diff to `regression_reviewer`. Record actionable results
  as `PLEX-675-NNN` and triage the complete set before editing.

- [ ] **Step 2: Run one data-safety discovery pass**

  Delegate to `data_safety_reviewer` because Plex history is Library Cleanup
  safety evidence. The reviewer must verify that compatibility fallback cannot
  publish partial watch history as complete.

- [ ] **Step 3: Address accepted findings in one batch**

  Add focused tests for accepted blockers, apply the smallest corrections, and
  request targeted closure from the assigned critics. Record unrelated
  hardening separately.

- [ ] **Step 4: Run the repository gauntlet**

  ```bash
  pnpm run format
  pnpm run typecheck
  pnpm run test
  pnpm run lint
  pnpm run build
  ```

  Expected: every branch-caused gate passes. Any inherited base failure remains
  visible with a base-branch reproduction.

- [ ] **Step 5: Open the focused pull request**

  Use `Related to #673` and `Related to #675` until the live reporter scenarios
  pass. Upgrade to standalone close lines only after exact verification.

- [ ] **Step 6: Request one hosted review**

  Triage the complete hosted finding set before editing. Use one remediation
  batch and targeted closure. Request a second full hosted review only after a
  material change to history pagination or cache-publication safety.

- [ ] **Step 7: Merge and verify `:dev`**

  Squash-merge after required checks and reviewers are green. Wait for the
  development-image workflow at the merge commit, then use humanized responses
  on #673 and #675.

- [ ] **Step 8: Assess `next` separately**

  Reproduce the request construction on `next`. If affected, forward-port the
  focused commit in a separate branch and pull request without merging `main`
  wholesale.
