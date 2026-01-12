# UI Standardization Tasks - v2.7.0

This document tracks all UI standardization issues identified for the 2.7.0 release.

## Overview

| Category | Files Affected | Priority | Status |
|----------|----------------|----------|--------|
| Z-Index Migration | 25+ files | HIGH | ✅ Completed |
| Hardcoded Colors | 15+ files | HIGH | ✅ Completed |
| Premium Component Adoption | 108 files | MEDIUM | In Progress |
| Loading State Standardization | 26 files | MEDIUM | Pending |
| Accessibility Enhancement | 107 files | LOW | Pending |

---

## HIGH PRIORITY

### 1. Z-Index Migration

Replace hardcoded z-index values with semantic Tailwind classes from the preset.

**Semantic Z-Index Scale:**
| Class | Value | Use Case |
|-------|-------|----------|
| `z-dropdown` | 10 | Dropdown menus |
| `z-sticky` | 20 | Sticky headers |
| `z-fixed` | 30 | Fixed elements |
| `z-modal-backdrop` | 40 | Modal overlays |
| `z-modal` | 50 | Modal dialogs |
| `z-popover` | 60 | Popovers |
| `z-toast` | 70 | Toast notifications |
| `z-tooltip` | 80 | Tooltips |

**Files to Update:**

#### UI Components (Base Layer)
- [ ] `components/ui/select.tsx` - z-50 → z-modal
- [ ] `components/ui/legacy-dropdown-menu.tsx` - z-50 → z-modal
- [ ] `components/ui/legacy-dialog.tsx` - z-50 → z-modal
- [ ] `components/ui/popover.tsx` - z-50 → z-popover
- [ ] `components/ui/tooltip.tsx` - z-50 → z-tooltip
- [ ] `components/ui/dialog.tsx` - z-50 → z-modal
- [ ] `components/ui/sheet.tsx` - z-50 → z-modal
- [ ] `components/ui/dropdown-menu.tsx` - z-50 → z-modal

#### Feature Components
- [ ] `components/presentational/queue-filters.tsx` - z-20, z-50, z-10
- [ ] `components/layout/sidebar.tsx` - z-50, z-40, z-10
- [ ] `features/dashboard/components/queue-action-buttons.tsx` - z-30
- [ ] `features/hunting/components/hunting-overview.tsx` - z-40, z-50
- [ ] `features/settings/components/backup-tab.tsx` - z-50
- [ ] `features/discover/components/tmdb-carousel.tsx` - z-10
- [ ] `features/trash-guides/components/custom-formats-browser.tsx` - z-50, z-10
- [ ] `features/trash-guides/components/quality-profile-browser.tsx` - z-50, z-10
- [ ] `features/trash-guides/components/template-stats.tsx` - z-50
- [ ] `features/trash-guides/components/quality-group-editor.tsx` - z-50
- [ ] `features/trash-guides/components/cf-configuration.tsx` - z-[60], z-10
- [ ] `features/trash-guides/components/bulk-score-manager.tsx` - z-20, z-10
- [ ] `features/trash-guides/components/sync-progress-modal.tsx` - z-50
- [ ] `features/trash-guides/components/bulk-deployment-modal.tsx` - z-40, z-50
- [ ] `features/trash-guides/components/template-list.tsx` - z-10, z-50
- [ ] `features/trash-guides/components/template-editor.tsx` - z-50, z-[60]
- [ ] `features/trash-guides/components/quality-profile-wizard.tsx` - z-50, z-10
- [ ] `app/(dashboard)/trash-guides/history/[syncId]/page.tsx` - z-50

**Note:** `z-10` for relative stacking within components is acceptable and doesn't need migration.

---

### 2. Hardcoded Color Cleanup

Replace hardcoded hex/rgb colors with theme system constants.

**Color Constants to Use:**
```typescript
// Service colors (from SERVICE_GRADIENTS)
SERVICE_GRADIENTS.sonarr  // { from: "#06b6d4", to: "#0891b2", glow: "..." }
SERVICE_GRADIENTS.radarr  // { from: "#f97316", to: "#ea580c", glow: "..." }
SERVICE_GRADIENTS.prowlarr // { from: "#a855f7", to: "#9333ea", glow: "..." }

// Or use getServiceGradient() for runtime lookups
```

**Files with Duplicated Service Colors:**

| File | Current | Should Use |
|------|---------|------------|
| `indexers/empty-indexers-card.tsx` | `#e6a23c` | `SERVICE_GRADIENTS.prowlarr.from` |
| `indexers/indexer-details-info.tsx` | `#f97316`, `#06b6d4` | `SERVICE_GRADIENTS` |
| `indexers/indexer-row.tsx` | `#f97316`, `#06b6d4` | `SERVICE_GRADIENTS` |
| `indexers/indexer-stats-grid.tsx` | `#f97316`, `#06b6d4` | `SERVICE_GRADIENTS` |
| `indexers/indexer-instance-card.tsx` | `#e6a23c` | `SERVICE_GRADIENTS.prowlarr.from` |
| `library/season-breakdown-modal.tsx` | `#06b6d4` | `SERVICE_GRADIENTS.sonarr.from` |
| `library/item-details-modal.tsx` | `#06b6d4`, `#f97316` | `SERVICE_GRADIENTS` |
| `manual-import/manual-import-modal.tsx` | `#06b6d4`, `#f97316` | `SERVICE_GRADIENTS` |
| `trash-guides/custom-formats-browser.tsx` | Inline gradients | `SERVICE_GRADIENTS` |
| `trash-guides/bulk-score-manager.tsx` | Inline gradients | `SERVICE_GRADIENTS` |
| `trash-guides/cache-status-section.tsx` | `#f97316`, `#06b6d4` | `getServiceGradient()` |
| `trash-guides/template-list.tsx` | `#f97316`, `#06b6d4` | `getServiceGradient()` |
| `dashboard/dashboard-client.tsx` | Inline gradient | Move to constants |

**Files with Other Hardcoded Colors:**

| File | Color | Purpose | Action |
|------|-------|---------|--------|
| `library/item-details-modal.tsx` | `#f5c518` | IMDB rating | Add to BRAND_COLORS |
| `library/item-details-modal.tsx` | `#5d8a3a` | Rotten Tomatoes | Add to BRAND_COLORS |
| `discover/tmdb-carousel.tsx` | `#fbbf24` | Star rating | Use SEMANTIC_COLORS.warning |
| `discover/media-card.tsx` | `#fbbf24` | Star rating | Use SEMANTIC_COLORS.warning |
| `trash-guides/template-diff-modal.tsx` | `#94a3b8` | Muted text | Use Tailwind `text-muted-foreground` |
| `settings/appearance-tab.tsx` | `#27272a`, `#e4e4e7` | Theme preview | Acceptable (theme preview colors) |

---

## MEDIUM PRIORITY

### 3. Premium Component Adoption

Expand usage of premium components to ensure consistency.

**Components to Adopt:**
- `PremiumSection` - For page sections with headers
- `GlassmorphicCard` - For card containers
- `PremiumEmptyState` - For empty/error states
- `PremiumSkeleton` - For loading states
- `ServiceBadge` - For service type indicators
- `StatusBadge` - For status indicators
- `PremiumTable`, `PremiumTableHeader`, `PremiumTableRow` - For tables

**Tier 1 - Highest Impact (COMPLETED):**
- [x] `library/library-card.tsx` - GlassmorphicCard, ServiceBadge, StatusBadge
- [x] `search/search-results-table.tsx` - PremiumTable, PremiumEmptyState, PremiumSkeleton, StatusBadge
- [x] `history/history-table.tsx` - PremiumTable, PremiumEmptyState, PremiumSkeleton, StatusBadge

**Tier 2 - High Impact (IN PROGRESS):**
- [ ] `library/library-content.tsx`
- [ ] `discover/media-card.tsx`
- [ ] `library/filter-controls.tsx`

**Tier 3 - Medium Impact:**
- [ ] `indexers/indexer-row.tsx`
- [ ] `indexers/indexer-stats-grid.tsx`
- [ ] `calendar/calendar-client.tsx`

**Tier 4 - Lower Impact:**
- [ ] Remaining feature components

---

### 4. Loading State Standardization

Ensure all loading states use consistent patterns.

**Current Coverage:** 26/125 files use PremiumSkeleton

**Pattern to Follow:**
```typescript
if (isLoading) {
  return (
    <PremiumSection title="Section Title" icon={Icon}>
      <div className="space-y-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <PremiumSkeleton
            key={i}
            variant="card"
            className="h-20"
            style={{ animationDelay: `${i * 50}ms` }}
          />
        ))}
      </div>
    </PremiumSection>
  );
}
```

---

## LOW PRIORITY

### 5. Accessibility Enhancement

Add proper ARIA attributes and keyboard navigation.

**Current Coverage:** 18/125 files have aria-/role= attributes

**Areas to Address:**
- [ ] Custom dropdown menus - Add role="menu", role="menuitem"
- [ ] Modal dialogs - Add aria-modal, aria-labelledby
- [ ] Interactive cards - Add role="button" or use `<button>`
- [ ] Status indicators - Add aria-live for dynamic content
- [ ] Form inputs - Ensure proper aria-describedby for errors

---

## New Constants to Add

### Brand/Rating Colors (theme-gradients.ts)

```typescript
export const BRAND_COLORS = {
  imdb: {
    bg: "#f5c51820",
    border: "#f5c51840",
    text: "#f5c518",
  },
  rottenTomatoes: {
    bg: "#5d8a3a20",
    border: "#5d8a3a40",
    text: "#5d8a3a",
  },
  tmdb: {
    bg: "#01d27720",
    border: "#01d27740",
    text: "#01d277",
  },
};

export const PROTOCOL_COLORS = {
  torrent: SERVICE_GRADIENTS.radarr.from,  // Orange
  usenet: SERVICE_GRADIENTS.sonarr.from,   // Cyan
};
```

---

## Progress Tracking

- [x] Phase 1: Z-Index Migration (HIGH) - ✅ Completed
- [x] Phase 2: Color Cleanup (HIGH) - ✅ Completed
- [ ] Phase 3: Premium Components (MEDIUM) - In Progress
- [ ] Phase 4: Loading States (MEDIUM)
- [ ] Phase 5: Accessibility (LOW)

---

*Last Updated: 2026-01-08*
*Version: 2.7.0*
