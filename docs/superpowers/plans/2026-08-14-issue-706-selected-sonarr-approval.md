# Selected Sonarr Approval Implementation Plan

> **Status:** Completed on 2026-08-14 through PRs #710, #711, and #712. This
> file is retained as historical execution evidence and must not be rerun.
>
> **For agentic workers:** REQUIRED PROJECT SKILLS: Use `arr-fix-issue` for
> issue work and `arr-validate` at the PR boundary. Checkboxes record the
> completed execution.

**Goal:** Ensure approving a Seerr request with a selected non-default Sonarr server sends that server and its selected defaults to the existing approval API.

**Architecture:** Keep the existing API contract and correct only the dialog's override baseline. Compare the submitted state against the request's original server or Seerr's original default server, never against the newly selected server itself.

**Tech Stack:** React 19, TypeScript, TanStack Query, Vitest, Testing Library, Next.js.

## Global Constraints

- Fix stable `main` first and forward-port separately to current `next`.
- Do not change the Seerr API route or shared request schema; they already forward `serverId: 0` and other explicit overrides.
- Preserve no-change approval behavior: confirming the original/default selection must not send a pointless update.
- The regression must cover a request without `request.serverId`, a default server with ID `1`, and a selected non-default server with ID `2`.
- Do not perform a real production request approval during verification.

---

### Task 1: Correct the approval override baseline on `main`

**Files:**
- Create: `apps/web/src/features/seerr/components/__tests__/approve-with-options-dialog.test.tsx`
- Modify: `apps/web/src/features/seerr/components/approve-with-options-dialog.tsx`

**Interfaces:**
- Consumes: `resolveSelectedServer(servers, serverId)`, `useSeerrRequestOptions(instanceId, mediaType)`, and `useApproveSeerrRequest()`.
- Produces: `approveMutation.mutate({ instanceId, requestId, overrides })` with explicit overrides whenever the final selection differs from the request's original/default routing state.

- [x] **Step 1: Add the failing non-default-server test**

  Mock `useSeerrRequestOptions` with two non-4K Sonarr servers:

  ```ts
  const defaultServer = {
    server: {
      id: 1,
      name: "Sonarr A",
      is4k: false,
      isDefault: true,
      activeProfileId: 10,
      activeDirectory: "/tv-a",
    },
    profiles: [{ id: 10, name: "HD-1080p" }],
    rootFolders: [{ id: 100, path: "/tv-a" }],
  };

  const alternateServer = {
    server: {
      id: 2,
      name: "Sonarr B",
      is4k: false,
      isDefault: false,
      activeProfileId: 20,
      activeDirectory: "/tv-b",
    },
    profiles: [{ id: 20, name: "WEB-1080p" }],
    rootFolders: [{ id: 200, path: "/tv-b" }],
  };
  ```

  Render an open dialog for a TV request with `serverId`, `profileId`, and
  `rootFolder` absent. Select `Sonarr B`, click `Approve`, and assert:

  ```ts
  expect(mutate).toHaveBeenCalledWith(
    {
      instanceId: "seerr-1",
      requestId: 42,
      overrides: {
        serverId: 2,
        profileId: 20,
        rootFolder: "/tv-b",
      },
    },
    expect.any(Object),
  );
  ```

- [x] **Step 2: Add the no-change control test**

  Render the same request and servers, leave `Sonarr A` selected, click
  `Approve`, and assert the mutation receives `overrides: undefined`. This
  preserves the existing audit behavior for an unchanged first-time route.

- [x] **Step 3: Run the new test and observe RED**

  Run:

  ```bash
  pnpm --filter @arr/web exec vitest run \
    src/features/seerr/components/__tests__/approve-with-options-dialog.test.tsx
  ```

  Expected result: the non-default test fails because `serverId` is omitted
  when `effectiveServerId` is derived from `selectedServer`.

- [x] **Step 4: Compute the original routing baseline**

  In `handleApprove`, resolve the original/default server independently of the
  current selection:

  ```ts
  const originalServer = resolveSelectedServer(filteredServers, request.serverId);
  const effectiveServerId = request.serverId ?? originalServer?.server.id;
  const effectiveProfileId = request.profileId ?? originalServer?.server.activeProfileId;
  const effectiveRootFolder = request.rootFolder ?? originalServer?.server.activeDirectory;
  ```

  Keep the existing comparisons and mutation contract. This causes changing
  from Sonarr A to Sonarr B to send all three values while unchanged approval
  remains update-free.

- [x] **Step 5: Run focused tests and confirm GREEN**

  Run:

  ```bash
  pnpm --filter @arr/web exec vitest run \
    src/features/seerr/components/__tests__/approve-with-options-dialog.test.tsx \
    src/features/seerr/components/__tests__/approval-queue-tab.test.tsx \
    src/hooks/api/__tests__/useSeerr.test.tsx
  ```

  Expected result: all selected tests pass.

- [x] **Step 6: Commit the stable correction**

  ```bash
  git add \
    apps/web/src/features/seerr/components/approve-with-options-dialog.tsx \
    apps/web/src/features/seerr/components/__tests__/approve-with-options-dialog.test.tsx
  git commit -m "fix(seerr): honor selected approval server"
  ```

### Task 2: Validate and review the stable branch

**Files:**
- Review only the two files changed by Task 1.

**Interfaces:**
- Consumes: Task 1 commit and focused test evidence.
- Produces: one frozen review inventory and a PR-ready stable branch.

- [x] **Step 1: Run the repository gauntlet**

  Run:

  ```bash
  pnpm run format
  pnpm --filter @arr/shared build
  pnpm run typecheck
  pnpm run test
  pnpm run lint
  pnpm run build
  git diff --check origin/main...HEAD
  ```

- [x] **Step 2: Verify the rendered interaction**

  Use a local populated fixture with two Sonarr choices. Confirm the visible
  selection changes to Sonarr B and the submitted mutation contains server ID
  `2`; do not approve a real production request.

- [x] **Step 3: Run one independent regression review**

  Review no-change behavior, ID `0` handling, server/profile/root-folder
  consistency, dialog reopen state, and the exact test assertion. Freeze the
  accepted findings and use at most one correction batch.

- [x] **Step 4: Prepare the focused PR**

  Use `Related to #706` until the exact two-server scenario has been verified.
  Apply one release bucket and record the PR in the stabilization ledger.

### Task 3: Forward-port the behavior to `next`

**Files:**
- Create or modify the corresponding dialog test on current `origin/next`.
- Modify: `apps/web/src/features/seerr/components/approve-with-options-dialog.tsx`

**Interfaces:**
- Consumes: the stable behavioral test and current 3.0 dialog implementation.
- Produces: the same selected-server behavior without importing unrelated stable changes.

- [x] **Step 1: Create a clean `next` worktree after the stable PR merges**

  Branch `codex/fix-706-selected-sonarr-next` from current `origin/next`.

- [x] **Step 2: Reproduce RED on `next`**

  Port only the two-server behavioral test and observe the same omitted override.

- [x] **Step 3: Apply the native minimal correction and run GREEN**

  Use the original/default routing baseline while preserving 3.0-specific
  incognito rendering and component structure.

- [x] **Step 4: Run the `next` gauntlet and open a separate PR**

  Run format, shared build, root typecheck, tests, lint, build, and rendered
  fixture verification. Record the stable and 3.0 PRs as one parity row.
