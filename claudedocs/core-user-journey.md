# Core User Journey - ARR Dashboard

**Last Updated**: 2025-11-19
**Purpose**: Document the critical path a user takes from first visit to successful value delivery

---

## Journey Overview

```
New User: First Visit → Setup → Login → Add Service → See Queue
Returning User: Login → View Dashboard (Queue Management)
```

---

## Step-by-Step Journey

### 1. First Landing - Setup Check
**Route**: Any route (except `/login`, `/setup`)
**File**: `apps/web/src/components/auth/auth-gate.tsx:19-36`

**Logic**:
```typescript
const PUBLIC_ROUTES = new Set(["/login", "/setup"]);

if (setupRequired && !PUBLIC_ROUTES.has(pathname)) {
  router.push("/setup");
  return;
}
```

**User Experience**:
- First-time visitor is immediately redirected to `/setup`
- Existing users skip to authentication check

**Risk**: None - smooth automatic redirect

---

### 2. Setup - Create Admin Account
**Route**: `/setup`
**File**: `apps/web/src/features/setup/components/setup-client.tsx`

**Options**: 3 authentication methods with tab navigation
1. **Password** (default tab) - Traditional username/password
2. **OIDC** - SSO integration (Authelia/Authentik)
3. **Passkey** - WebAuthn modern authentication

**User Experience**:
- Clear tab navigation between methods
- Default to password (most familiar)
- Each method has dedicated form

**UX Smell** 🟡:
- Tab navigation pattern unclear if all 3 can be set up or just one choice
- No explicit "Choose one method" guidance
- Password setup shown first but passkeys are more secure

**Code Reference**: `setup-client.tsx:23-26`

---

### 3. Login - Authenticate
**Route**: `/login`
**File**: `apps/web/src/features/auth/components/login-form.tsx`

**Options**: Same 3 methods as setup
1. Passkey (shown first if available)
2. OIDC
3. Password

**User Experience**:
- Automatic redirect to `/setup` if no users exist (`login-form.tsx:61-66`)
- "Remember me" checkbox (30 days)
- Error messages displayed clearly
- Redirect to original route after login

**UX Smell** 🟡:
- Login shows passkeys first but setup shows password first (inconsistent priority)
- No indication which auth methods are actually configured

**Code Reference**: `login-form.tsx:61-66, 122-208`

---

### 4. Critical Path - Add First Service
**Route**: `/settings` (Services tab - default)
**File**: `apps/web/src/features/settings/components/settings-client.tsx`

**Process**:
1. User lands on Settings → Services tab
2. Fills service form (right side of screen)
   - Choose service type: Radarr, Sonarr, or Prowlarr (buttons)
   - Enter label (e.g., "Main Radarr")
   - Enter base URL (e.g., `http://localhost:7878`)
   - Enter API key
   - Test connection (optional but recommended)
   - Add tags (optional)
   - Configure default settings (Radarr/Sonarr only - disabled until service saved)
   - Enable/Default checkboxes

**User Experience**:
- Service types shown as clickable buttons (good visual clarity)
- "Test connection" before saving (reduces errors)
- Default settings section disabled until service is saved (forces two-step process)

**UX Smell** 🔴:
- Default settings LOCKED until service is saved first
- User must: Add service → Save → Edit service → Configure defaults → Save again
- Two-save workflow not explained anywhere
- High friction for first-time setup

**Code Reference**:
- Form: `service-form.tsx:73-257`
- Defaults: `service-form.tsx:192-210`
- Settings client: `settings-client.tsx:82-91`

---

### 5. First Success - View Queue
**Route**: `/dashboard`
**File**: `apps/web/src/features/dashboard/components/dashboard-client.tsx`

**Main Action**: Queue Management
- View download queue items
- Filter by service (Radarr/Sonarr)
- Filter by instance (if multiple)
- Pagination

**User Experience**:
- Clean queue view of downloads
- Clear success indicator (seeing items downloading)

**Risk** 🟡:
- If no downloads active, dashboard appears empty
- No onboarding hint to "go add something to download"

---

## Critical Success Path

**Minimum actions for value delivery**:
1. Setup admin account (1 minute)
2. Login (30 seconds)
3. Add Radarr/Sonarr service (2 minutes)
   - ⚠️ **FRICTION POINT**: Two-save workflow for defaults
4. (Outside app) Add media to Radarr/Sonarr
5. View queue on dashboard (immediate value)

**Total onboarding time**: ~5 minutes (with two-save friction)

---

## Known UX/Code Smells

### 🔴 CRITICAL - High Friction

**1. Two-Save Workflow for Service Defaults**
- **Location**: `service-form.tsx:192-210`, `settings-client.tsx:58-79`
- **Problem**: Default settings (quality profiles, root folders) are LOCKED until service is saved first
- **User Impact**:
  - Must save service → edit service → configure defaults → save again
  - No explanation of this requirement
  - High cognitive load for first-time setup
- **Code Cause**: `useDiscoverOptionsQuery` requires saved `serviceId` to fetch options
  ```typescript
  const editingSupportsDefaults = Boolean(
    selectedServiceForEdit &&
    selectedServiceForEdit.service !== "prowlarr"
  );

  useDiscoverOptionsQuery(
    editingSupportsDefaults ? (selectedServiceForEdit?.id ?? null) : null,
    // ...
  );
  ```
- **Recommendation**: Allow fetching options with baseUrl + apiKey BEFORE saving

---

### 🟡 IMPORTANT - Consistency Issues

**2. Authentication Method Priority Inconsistency**
- **Location**: `setup-client.tsx:23` vs `login-form.tsx:122-208`
- **Problem**: Setup shows Password first, Login shows Passkey first
- **User Impact**: Cognitive dissonance - which is the "recommended" method?
- **Recommendation**: Consistent ordering (suggest: Passkey → Password → OIDC)

**3. Setup Tab Navigation Ambiguity**
- **Location**: `setup-client.tsx:35-52`
- **Problem**: Tab UI suggests "choose one" but doesn't explicitly state it
- **User Impact**: Uncertainty about whether to set up all 3 methods or just 1
- **Recommendation**: Add help text "Choose your preferred authentication method"

---

### 🟢 MINOR - Polish Opportunities

**4. Empty Dashboard State**
- **Location**: `dashboard-client.tsx`
- **Problem**: No onboarding prompt when queue is empty
- **User Impact**: New users see blank screen, unsure what to do next
- **Recommendation**: Add empty state with call-to-action

**5. No Auth Method Visibility on Login**
- **Location**: `login-form.tsx`
- **Problem**: All 3 auth forms shown even if only 1 is configured
- **User Impact**: Visual clutter, potential confusion
- **Recommendation**: Show only configured methods or indicate which are available

---

## Key Findings

### What Works Well ✅
1. **Automatic Setup Detection** - Smart redirect on first visit
2. **Service Type Selection** - Clear button UI for Radarr/Sonarr/Prowlarr
3. **Test Connection** - Reduces API key errors before saving
4. **Tab Navigation** - Clear separation between settings sections

### What Needs Improvement ⚠️
1. **Two-Save Workflow** - Biggest friction point (CRITICAL)
2. **Auth Method Consistency** - Setup vs Login ordering mismatch
3. **Setup Guidance** - Tab UI doesn't explain "choose one" clearly
4. **Empty States** - No onboarding hints when dashboard is empty

---

## Recommended Priority Fixes

Based on user impact and implementation effort:

1. **DEFERRED**: Fix two-save workflow for service defaults
   - **Problem**: Requires saved `instanceId` to fetch quality profiles/root folders
   - **Root Cause**: `apps/api/src/routes/discover/options-routes.ts:33-55` uses `createInstanceFetcher` which requires database record
   - **Solution**: Would need new API endpoint accepting baseUrl + apiKey (not instanceId)
   - **Status**: Architectural change - out of scope for "safe improvements"
   - **Workaround**: Add help text explaining the two-step process
   - **Impact**: 50% reduction in setup friction if implemented

2. **IMPLEMENTED**: Consistent auth method ordering
   - Use same order in setup and login (Passkey → Password → OIDC)
   - **Impact**: Reduced cognitive load
   - **Files**: `setup-client.tsx`, `login-form.tsx`

3. **IMPLEMENTED**: Setup guidance - add 'choose one' help text
   - Add CardDescription explaining "choose your preferred method"
   - **Impact**: Clearer onboarding expectations
   - **File**: `setup-client.tsx`

4. **IMPLEMENTED**: Service defaults - explain two-step process
   - Add help text in disabled state: "Save service first, then configure defaults"
   - **Impact**: Reduces confusion about locked UI
   - **File**: `service-form.tsx`
