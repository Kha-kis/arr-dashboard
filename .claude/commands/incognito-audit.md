Audit incognito/privacy coverage for: $ARGUMENTS

If no target specified, audit files changed on the current branch (`git diff --name-only origin/main..HEAD`).

---

## Step 1: Identify the audit surface

1. Determine the target: a feature directory, page, route, component set, or API response
2. List every component in scope that renders user-visible data
3. For each component, note whether it currently imports from `lib/incognito.ts` or calls `useIncognitoMode()`

---

## Step 2: Classify sensitive data fields

For every data field rendered in the target surface, classify it:

| Category | Examples | Anonymizer |
|---|---|---|
| Media titles | movie/series/album/book names, episode titles | `getLinuxIsoName()` |
| Instance names | Sonarr/Radarr/Plex instance labels | `getLinuxInstanceName()` |
| Usernames | Plex users, Seerr requesters, account names | `getLinuxUsername()` |
| URLs | service baseUrl, externalUrl, API endpoints | `getLinuxUrl()` |
| File paths | download paths, save locations | `getLinuxSavePath()` |
| IP addresses | client IPs, server addresses | `getLinuxIpAddress()` |
| Device names | player names, stream device identifiers | `getLinuxDevice()` |
| Email addresses | account emails, notification targets | `getLinuxEmail()` |
| Library sections | Plex library names | `getLinuxSectionName()` |
| Server names | Plex server friendly names | `getLinuxServerName()` |
| Indexer names | Prowlarr indexer labels | `getLinuxIndexer()` |
| Download clients | client names in queue/status messages | `getLinuxDownloadClient()` |
| Health messages | free-text from *arr health API | `anonymizeHealthMessage()` |
| Status messages | queue errors, import failures | `anonymizeStatusMessage()` |

If a field does not fit any category, flag it as a potential gap.

---

## Step 3: Inspect every render path

For each component in scope, check these render paths for unmasked sensitive data:

### Primary content
- [ ] Card titles and subtitles
- [ ] Table cells and row content
- [ ] List items and labels
- [ ] Badge/tag text content
- [ ] Chart labels and tooltips

### Interactive surfaces
- [ ] Dialog/modal titles and body content
- [ ] Popover/tooltip text
- [ ] Dropdown option labels
- [ ] Link text and `href`/`title` attributes
- [ ] Button labels that include dynamic data

### State-dependent renders
- [ ] Loading states — do skeleton placeholders leak real data?
- [ ] Empty states — do "no results for X" messages include the search term?
- [ ] Error states — do error messages embed instance names, URLs, or media titles?
- [ ] Toast/notification content

### Derived values
- [ ] Concatenated strings that join identifiable parts (e.g., `"Label: message"` patterns)
- [ ] Template literals that embed service names, URLs, or titles
- [ ] `aria-label` or `title` attributes with dynamic content
- [ ] Image `alt` text derived from media titles

---

## Step 4: Inspect backend response shaping

For API routes that serve the target feature:

1. Check if any response fields embed identifiable data inside free-text strings
   - Health messages from *arr APIs often contain indexer names, show titles, and download client names in a single string
   - Pulse titles may use `"Label: message"` format where both parts are identifiable
2. If identifiable values are embedded in a string, flag it — the frontend cannot anonymize parts of a string without regex, which is fragile
3. Preferred pattern: return identifiable fields as separate properties so the frontend can anonymize each independently

---

## Step 5: Check test implications

1. Components using `useIncognitoMode()` require `<IncognitoProvider>` wrapper in tests
2. If the audit adds `useIncognitoMode()` to a component that was previously unwrapped, its tests will break without the provider
3. Flag any test files that would need the wrapper added

---

## Step 6: Report findings

Group by severity:

### Must-fix
Sensitive data rendered without any anonymization when incognito mode is active. Direct leak visible to anyone viewing the screen.

### Should-fix
Partial coverage — the main content is anonymized but secondary surfaces (tooltip, aria-label, error state, link href) still expose the original value.

### Acceptable
Data that is inherently non-sensitive (generic status text, boolean flags, counts, timestamps without context) or where anonymization would make the UI unusable.

### Report format

For each finding:
- **Location**: `file:line` or component name
- **Field**: what data is exposed
- **Render path**: where it appears (card title, tooltip, error message, etc.)
- **Recommended fix**: which anonymizer to apply, or "restructure backend response"

Do NOT implement fixes unless explicitly asked. Report only.

---

## Rules

- Read the component code — do not rely on file names or function names to infer coverage
- Check `useMemo` dependency arrays: if `incognitoMode` is missing from a `useMemo` that transforms display data, toggling incognito will not re-render the anonymized value
- The `anonymizeHealthMessage()` and `anonymizeStatusMessage()` functions use regex and may miss new message formats from service updates — flag any format they would not catch
- Backend responses are not in scope for anonymization — the backend never knows about incognito mode. All anonymization happens on the frontend
- If a component conditionally renders via `{flag && <Component />}`, check both the conditional and the inner component
