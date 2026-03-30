Run or write E2E tests for: $ARGUMENTS

If no target specified, run the full E2E suite against the current state.

---

## Step 1: Determine the action

Classify what's needed based on the task:

| Signal | Action |
|--------|--------|
| `run`, `check`, `verify`, no specific target | **Run** existing tests |
| Names a feature, page, or spec file | **Run** that specific test file |
| `write`, `add`, `cover`, `new test` | **Write** new test(s) |
| `debug`, `flaky`, `failing`, `fix test` | **Debug** a failing test |

---

## Step 2: Run tests (CLI-first)

Use the Playwright CLI directly — it is the most token-efficient approach.

**Run all E2E tests:**
```
npx playwright test
```

**Run a specific spec file:**
```
npx playwright test e2e/<feature>.spec.ts
```

**Run integration tests (requires services running):**
```
pnpm run e2e:integration
```

**Run with visible browser for debugging:**
```
npx playwright test e2e/<feature>.spec.ts --headed
```

**Run a single test by title:**
```
npx playwright test -g "test title pattern"
```

**Show the HTML report after a run:**
```
npx playwright show-report
```

Read the CLI output to determine pass/fail. Do not read spec file source unless actively debugging or writing tests.

### Environment requirements
- The app must be running: `pnpm run dev` (API on 3001, web on 3000)
- Auth credentials: `TEST_USERNAME` and `TEST_PASSWORD` in `.env.test` or environment
- In CI: credentials are auto-generated (`ci-test-user` / `CiTestP@ssw0rd123!`)

---

## Step 3: Write new tests

When writing new E2E tests, follow the existing patterns:

1. **Read an analogous spec** before writing. Existing specs:
   - `e2e/dashboard.spec.ts` — widget rendering, data display
   - `e2e/requests.spec.ts` — Seerr request lifecycle
   - `e2e/settings.spec.ts` — form interaction, service configuration
   - `e2e/navigation.spec.ts` — sidebar, routing, responsive layout
   - `e2e/library.spec.ts` — data tables, filtering, modals

2. **Use shared helpers** from `e2e/utils/test-helpers.ts`:
   - `navigateTo(page, 'dashboard')` — route navigation with auth retry
   - `waitForPageHeading(page, 'Dashboard')` — heading visibility
   - `waitForLoadingComplete(page)` — skeleton/spinner wait
   - `selectTab(page, 'Overview')` — tab interaction
   - `waitForModal(page)` / `closeModal(page)` — dialog lifecycle
   - `fillFieldByLabel(page, 'Label', 'value')` — form input
   - `clickSidebarLink(page, 'Library')` — navigation

3. **Auth setup** is handled by `e2e/auth.setup.ts` — tests run with an authenticated session stored in `.playwright-auth/user.json`. Do not add login steps to individual tests.

4. **Test structure conventions:**
   - Group by `test.describe('Feature Name', ...)` per page/feature
   - Use `test.beforeEach(async ({ page }) => { await navigateTo(page, 'route'); })` for navigation
   - Prefer role-based selectors: `page.getByRole('button', { name: /submit/i })`
   - Use `TIMEOUTS` constants from test-helpers, not hardcoded waits
   - Keep tests independent — no test should depend on another test's side effects

5. **Incognito mode testing**: If covering privacy-sensitive features, add a test that:
   - Toggles incognito mode via the topbar button
   - Verifies that titles/names change to Linux ISO names
   - Verifies that toggling back restores original data

---

## Step 4: Debug failing tests

1. **Read the error output** from the CLI first — most failures are clear from the message
2. **Check the trace** if the error is unclear:
   ```
   npx playwright show-trace test-results/<test-name>/trace.zip
   ```
3. **Use the Playwright plugin** to take a screenshot of the page at the failure point if the trace isn't sufficient
4. **Common failure patterns in this repo:**
   - Auth state race condition — the single-worker config mitigates this, but session expiry can still cause redirects to `/login`
   - Network idle timeout — increase `TIMEOUTS.apiResponse` if backend is slow to respond
   - Skeleton/loading state — `waitForLoadingComplete()` may return before all data renders; add a specific element wait after it
   - Stale selectors — if UI was refactored, selectors in the spec may not match

---

## Step 5: Report results

After running tests, report:
- **Pass/fail count** from CLI output
- **Failures**: test name, error message, and which spec file
- **Flaky tests**: any that passed on retry
- **Recommendation**: fix needed, or tests are green

---

## Rules

- Prefer CLI commands over reading/writing test source files — this is more token-efficient
- Use `npx playwright test` as the primary entry point, not `pnpm run test` (which runs unit tests)
- The app must be running locally for E2E tests to work — if tests fail with connection errors, check that `pnpm run dev` is active
- Integration tests (`e2e:integration`) require Docker services — run `pnpm run e2e:integration:up` first
- Do not modify `e2e/auth.setup.ts` unless the auth flow itself changed
- Do not add `test.only` — the CI config (`forbidOnly: true`) will reject it
- Workers are forced to 1 to prevent session race conditions — do not change this
- When writing tests for new features, check if the feature has service-availability gating (Plex, Seerr, Tautulli) — tests may need to handle the "service not configured" state
