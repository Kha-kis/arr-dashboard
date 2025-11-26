# UX Reality Check - arr-dashboard

**Date**: 2025-11-19
**Purpose**: Systematize "vibe-coded" UI into predictable UX foundation

---

## Current State Assessment

### ✅ What's Working
- **Design Token System**: Comprehensive token system exists in `src/styles/tokens/tailwind-preset.ts`
  - Semantic colors (bg, fg, primary, accent, success, warning, danger)
  - Spacing scale (0-24 in 4px increments)
  - Typography scale (h1-h4, body, small)
  - Well-defined button variants (primary, secondary, ghost, danger, gradient)
- **Component Foundation**: Button component has clear variant system with 5 types
- **Modern Stack**: Next.js App Router, Tailwind CSS, TypeScript

### 🟡 Pain Points
- **Layout Duplication**: Same layout classes repeated across 11 pages
- **Inconsistent Spacing**: Random gap values (gap-1, gap-3, gap-4, gap-6, gap-8, gap-12) without pattern
- **Ad-hoc Typography**: Text sizes applied without hierarchy (text-xs, text-sm, text-base scattered)
- **No Layout Components**: Common page structure not abstracted
- **Multiple Primary Actions**: Some screens have 2-3 primary buttons (violates hierarchy)

---

## Primary Screens & User Flows

### 1. Onboarding Flow
**Entry**: `/auth/login` → Login Form Component
**Actions**:
- Password login (email + password)
- OIDC login (provider button)
- Passkey login (WebAuthn)

**Exit**: Redirect to `/dashboard` after successful auth

### 2. Dashboard Flow (Core Action)
**Entry**: `/dashboard` → Dashboard Client Component
**Primary Actions**:
- View download queue (movies/shows in progress)
- Filter queue by status (downloading, failed, completed)
- Search queue items
- Paginate through large queues

**Secondary Actions**:
- Refresh queue status
- Clear filters

### 3. Discovery Flow
**Entry**: `/discover` → Discover Client Component
**Primary Actions**:
- Search movies/shows by title
- View search results
- Add item to Radarr/Sonarr

**Secondary Actions**:
- Switch between movie/series modes
- View item details

### 4. Configuration Flow
**Entry**: `/settings` → Settings Client Component
**Tab Navigation**: Services | Tags | Account | Authentication | Backup

**Services Tab Primary Actions**:
- Add new service (Radarr/Sonarr/Prowlarr)
- Configure service defaults (quality profiles, root folders)
- Test connection
- Enable/disable service
- Delete service

**Account Tab Primary Actions**:
- Update account info (name, email)
- Change password
- Manage passkeys
- Configure OIDC

### 5. TRaSH Guides Flow
**Entry**: `/trash-guides` → TRaSH Guides Client Component
**Primary Actions**:
- Create quality profile from template
- Configure custom formats
- Deploy to instances
- Manage templates

---

## Design System Rules

### Spacing Scale (4px base unit)
```yaml
Primary Scale (use these):
  gap-2:  8px   # Tight groups (form field + label)
  gap-4:  16px  # Related items (buttons, form sections)
  gap-6:  24px  # Distinct sections (card content)
  gap-8:  32px  # Major sections (page sections)
  gap-12: 48px  # Page-level spacing (between major blocks)

Avoid:
  gap-1, gap-3, gap-5, gap-7 → Pick nearest primary scale value
```

### Typography Hierarchy
```yaml
Headings:
  h1: text-3xl font-bold     # Page titles
  h2: text-2xl font-bold     # Section titles
  h3: text-xl font-semibold  # Subsection titles
  h4: text-lg font-semibold  # Card/component titles

Body:
  body:   text-base          # Default text
  small:  text-sm            # Secondary info
  caption: text-xs           # Metadata, labels

Avoid:
  Random text-* classes without hierarchy context
```

### Button Variants (from button.tsx)
```yaml
Hierarchy (max 1 primary per screen):
  primary:   Main call-to-action (Add, Save, Submit)
  secondary: Alternative actions (Cancel, Back, Close)
  ghost:     Tertiary actions (Edit, Delete in lists)
  danger:    Destructive actions (Delete, Remove)
  gradient:  Special promotions (rarely used)

Sizes:
  sm: Compact controls in tables/lists
  md: Default buttons (forms, actions)
  lg: Prominent CTAs (landing pages)
```

### Color Tokens (from tailwind-preset.ts)
```yaml
Semantic Colors:
  bg-*:      Background layers (bg, subtle, card, popover, input)
  fg-*:      Foreground text (base, muted, subtle, placeholder)
  primary-*: Primary brand actions (base, fg, subtle, border)
  accent-*:  Secondary brand actions (base, fg, subtle, border)
  success-*: Positive states (base, fg, subtle)
  warning-*: Caution states (base, fg, subtle)
  danger-*:  Error/destructive states (base, fg, subtle)

Usage:
  ✅ bg-card text-fg-base border-primary
  ❌ bg-gray-800 text-white border-blue-500
```

### Navigation Patterns
```yaml
Current Pattern: Top Navigation
  - Logo + app name (left)
  - Main nav links (center): Dashboard, Discover, Library, Settings, TRaSH Guides
  - User menu (right): Account settings, logout

Page Pattern:
  <main className="mx-auto max-w-6xl px-6 py-16">
    <header className="mb-8">
      <h1>Page Title</h1>
      <p>Description</p>
    </header>
    <section className="space-y-8">
      {/* Page content */}
    </section>
  </main>
```

---

## UX Issues Identified

### Issue 1: Layout Duplication
**Problem**: 11 pages use identical layout classes
**Files Affected**: All pages in `app/` directory
```tsx
// Repeated 11 times:
<main className="mx-auto flex max-w-6xl flex-col gap-12 px-6 py-16">
```

**Fix**: Create `<PageLayout>` component
```tsx
// src/components/layout/page-layout.tsx
export const PageLayout = ({
  children,
  maxWidth = "6xl"
}: {
  children: ReactNode;
  maxWidth?: "4xl" | "6xl" | "7xl"
}) => (
  <main className={cn("mx-auto flex flex-col gap-12 px-6 py-16", `max-w-${maxWidth}`)}>
    {children}
  </main>
);
```

### Issue 2: Inconsistent Gap Usage
**Problem**: 6 different gap values used without pattern
**Evidence**: gap-1, gap-3, gap-4, gap-6, gap-8, gap-12

**Fix**: Enforce spacing scale
```yaml
Replace with primary scale:
  gap-1 → gap-2  (8px)
  gap-3 → gap-4  (16px)
  gap-5 → gap-6  (24px)
  gap-7 → gap-8  (32px)
```

### Issue 3: Ad-hoc Typography
**Problem**: Text sizes applied without hierarchy
**Evidence**: text-xs, text-sm, text-base scattered without semantic meaning

**Fix**: Use semantic classes
```tsx
// Before:
<p className="text-sm text-white/60">Metadata</p>

// After:
<p className="text-caption text-fg-muted">Metadata</p>
```

### Issue 4: Multiple Primary Actions
**Problem**: Some screens have 2-3 primary buttons
**Example**: Settings page - "Add service", "Save changes", "Test connection" all primary

**Fix**: Hierarchy enforcement
```tsx
// Settings form:
<Button variant="primary">Add service</Button>      {/* 1 primary per screen */}
<Button variant="secondary">Test connection</Button> {/* Supporting action */}
<Button variant="ghost">Cancel</Button>              {/* Tertiary action */}
```

### Issue 5: No Section Component
**Problem**: Section spacing inconsistent
**Evidence**: Some sections use `space-y-4`, others `gap-6`, others `mb-8`

**Fix**: Create `<Section>` component
```tsx
export const Section = ({
  title,
  description,
  children
}: {
  title?: string;
  description?: string;
  children: ReactNode
}) => (
  <section className="space-y-6">
    {title && (
      <header className="space-y-2">
        <h2 className="text-h3">{title}</h2>
        {description && <p className="text-small text-fg-muted">{description}</p>}
      </header>
    )}
    {children}
  </section>
);
```

### Issue 6: Card Spacing Variance
**Problem**: Card components use different padding/gap combinations
**Evidence**: Some cards use `p-4`, others `p-6`, content spacing varies

**Fix**: Standardize card spacing
```tsx
// Standard card pattern:
<Card className="p-6 space-y-6">
  <CardHeader className="space-y-2">
    <CardTitle className="text-h3">{title}</CardTitle>
    <CardDescription className="text-small">{description}</CardDescription>
  </CardHeader>
  <CardContent className="space-y-4">
    {children}
  </CardContent>
</Card>
```

---

## Implementation Priorities

### Phase 1: Foundation (High Impact, Low Risk)
1. ✅ **Create `<PageLayout>` component** - Eliminates 11 instances of duplication
2. ✅ **Create `<Section>` component** - Standardizes section spacing
3. ✅ **Add typography utility classes** - Semantic text sizing

**Files to Create**:
- `src/components/layout/page-layout.tsx`
- `src/components/layout/section.tsx`
- `src/styles/typography.ts` (utility classes)

### Phase 2: Refactor High-Traffic Screens (Immediate UX Improvement)
1. **Dashboard Page** (`app/dashboard/page.tsx`)
   - Replace layout classes with `<PageLayout>`
   - Use `<Section>` for queue/filters
   - Enforce button hierarchy (1 primary max)

2. **Settings Page** (`app/settings/page.tsx`)
   - Replace layout classes with `<PageLayout>`
   - Fix button hierarchy (multiple primaries currently)
   - Standardize form spacing (gap-4 for fields, gap-6 for sections)

**Expected Impact**:
- 30% reduction in layout code duplication
- Consistent spacing across all pages
- Clear visual hierarchy with button variants

### Phase 3: Polish (Optional, Future Enhancement)
1. Add animation tokens (transition durations already defined)
2. Create form field component (label + input + error pattern)
3. Standardize loading states (spinner, skeleton, etc.)

---

## Design System Checklist

### Layout Components
- [ ] `<PageLayout>` - Standard page container
- [ ] `<Section>` - Section spacing and headers
- [ ] `<PageHeader>` - Page title + description pattern

### Typography System
- [ ] Add `text-h1`, `text-h2`, `text-h3`, `text-h4` utilities
- [ ] Add `text-body`, `text-small`, `text-caption` utilities
- [ ] Document when to use each level

### Spacing Rules
- [ ] Audit all gap-* usage and consolidate to primary scale
- [ ] Document spacing scale in Storybook or component docs
- [ ] Create spacing decision tree (when to use gap-2 vs gap-4)

### Button Guidelines
- [ ] Document "1 primary per screen" rule
- [ ] Create button usage examples (when primary vs secondary vs ghost)
- [ ] Add button size guidelines (sm for tables, md for forms, lg for CTAs)

### Color Usage
- [ ] Replace hardcoded colors with semantic tokens
- [ ] Document color token usage (bg-* vs fg-* vs primary-*)
- [ ] Create color contrast checklist for accessibility

---

## Success Metrics

**Code Quality**:
- 80% reduction in layout class duplication
- 100% of pages use `<PageLayout>` component
- 90% of gap-* values conform to primary scale

**UX Quality**:
- Maximum 1 primary button per screen
- Consistent section spacing (±8px tolerance)
- Clear typography hierarchy (h1 > h2 > h3 > body)

**Developer Experience**:
- New pages created with layout components (no layout classes needed)
- Spacing decisions made from documented scale (no guessing)
- Button hierarchy enforced via code review checklist
