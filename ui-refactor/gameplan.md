# UI Refactor Gameplan

## Environment Detection Summary

**Stack**: Next.js 14 (App Router) + Tailwind CSS 3.4 + TypeScript
**Package Manager**: pnpm
**Theme System**: next-themes (class-based dark mode)
**Animation**: Framer Motion + tailwindcss-animate
**Icons**: Lucide React
**Toast**: Sonner
**Forms**: Zod validation

**Current UI State**:
- ✅ Tailwind configured with basic brand colors
- ✅ Some shadcn-style primitives exist (Button, Card, Input)
- ✅ next-themes installed for dark mode
- ⚠️ No formal design tokens system
- ⚠️ Hard-coded colors (sky-500, white/opacity) scattered throughout
- ⚠️ Incomplete theming (no CSS variables for colors)
- ⚠️ Missing primitives (Select, Checkbox, Radio, Modal, etc.)

---

## Token Plan

### Color System
**Semantic tokens** (light/dark aware):
- Background: `--color-bg`, `--color-bg-subtle`, `--color-bg-muted`
- Foreground: `--color-fg`, `--color-fg-muted`, `--color-fg-subtle`
- Brand/Primary: `--color-primary`, `--color-primary-fg`
- Semantic: `--color-success`, `--color-warning`, `--color-danger`, `--color-info`
- Interactive: `--color-border`, `--color-border-hover`, `--color-focus-ring`

**Naming Strategy**: HSL-based with opacity modifiers for Tailwind compatibility

### Spacing Scale
- Use Tailwind's default spacing (0, 2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64)
- Expose as CSS vars: `--space-*`

### Typography
- Font families: `--font-sans` (Inter), `--font-mono`
- Scale: `--text-xs` through `--text-3xl` (map to Tailwind)
- Line heights: `--leading-tight`, `--leading-normal`, `--leading-relaxed`

### Radius
- `--radius-sm` (4px), `--radius-md` (8px), `--radius-lg` (12px), `--radius-xl` (16px), `--radius-2xl` (24px)

### Shadows
- `--shadow-sm`, `--shadow-md`, `--shadow-lg`, `--shadow-xl`

### Z-Index Layers
- `--z-base` (0), `--z-dropdown` (1000), `--z-modal` (2000), `--z-toast` (3000), `--z-tooltip` (4000)

### Animation
- Durations: `--duration-fast` (100ms), `--duration-normal` (200ms), `--duration-slow` (300ms)
- Easing: `--ease-standard`, `--ease-in`, `--ease-out`

---

## Theme Strategy

### Implementation
1. **CSS Variables** in `tokens/theme.css` with light/dark themes
2. **Tailwind Preset** mapping tokens to Tailwind theme.extend
3. **ThemeProvider** wrapper using next-themes
4. **data-theme** attribute on root for theme-specific styling

### Migration
- Convert hard-coded colors (e.g., `sky-500`, `white/10`) to semantic tokens
- Preserve existing Tailwind utilities where they map cleanly to tokens
- Add dark mode variants where missing

---

## Component Taxonomy

### Tier 1: Primitives (Headless/Minimal)
**Existing** (to enhance):
- Button ✓ (add sizes, loading state, icon support)
- Input ✓ (add validation states, helper text)
- Card ✓ (add variants)

**Missing** (to implement):
- Label, HelperText, ErrorMessage
- Select, Textarea, Checkbox, Radio, Switch
- Badge, Avatar
- Tooltip, Popover
- Modal/Dialog, Sheet
- Tabs, Accordion (use Radix if available)
- Skeleton, Spinner
- Table (headless wrapper)

### Tier 2: Compositions
- Field (Label + Input/Select + Helper + Error)
- Form helpers (Zod integration)
- Toast (expose Sonner with our theme)
- CommandPalette (if needed)

### Public API
All exports via `apps/web/src/components/ui/index.ts` barrel

---

## Accessibility & UX Checklist

### Keyboard
- ✅ Tab navigation for all interactive elements
- ✅ Escape to close modals/dropdowns
- ✅ Arrow keys for Select/Radio groups
- ✅ Return focus to trigger on modal close

### ARIA
- ✅ `aria-label` or `aria-labelledby` on all interactive controls
- ✅ `aria-describedby` for helper text and errors
- ✅ `aria-invalid` on error states
- ✅ `role` attributes where semantic HTML insufficient
- ✅ Live regions for toasts and async feedback

### Visual
- ✅ Focus indicators (visible ring on all focusable elements)
- ✅ Color contrast ≥ WCAG AA (4.5:1 for text, 3:1 for UI)
- ✅ Touch targets ≥ 44x44px

### Motion
- ✅ Respect `prefers-reduced-motion`
- ✅ Limit auto-animations and parallax

### Responsive
- ✅ Mobile-first breakpoints
- ✅ Fluid typography (clamp where appropriate)
- ✅ Touch-friendly spacing

---

## Risks & Mitigation

### Risk 1: Visual Regressions
**Mitigation**: Preserve existing class names as fallbacks; opt-in to new tokens via feature flag or gradual migration

### Risk 2: Breaking Existing Components
**Mitigation**: Extend existing components rather than replace; use codemods for safe migrations

### Risk 3: Dark Mode Inconsistencies
**Mitigation**: Test both themes on every route; use semantic tokens to ensure consistency

### Risk 4: Bundle Size
**Mitigation**: Tree-shakeable exports; no heavy dependencies; leverage existing libraries (Radix, Framer Motion)

### Risk 5: Accessibility Regressions
**Mitigation**: Run axe-core on baseline and after changes; manual keyboard testing

---

## Commit Plan

1. `feat(ui): add design tokens and CSS variables for theming`
2. `feat(ui): create Tailwind preset from design tokens`
3. `feat(ui): enhance existing Button, Input, Card with token-based styling`
4. `feat(ui): add missing UI primitives (Select, Checkbox, Modal, etc.)`
5. `feat(ui): create Field composition component with validation states`
6. `feat(ui): implement public API barrel and documentation`
7. `refactor(ui): migrate hard-coded colors to semantic tokens`
8. `chore(eslint): add UI consistency rules and import boundaries`
9. `test(ui): add unit tests for primitives and a11y coverage`
10. `docs(ui): add UI architecture guide and component usage docs`

---

## Success Criteria

- ✅ All components use semantic tokens (no hard-coded colors/spacing)
- ✅ Dark mode works consistently across all routes
- ✅ WCAG AA accessibility compliance
- ✅ Zero visual regressions on existing flows
- ✅ Public API documented with usage examples
- ✅ Lint rules enforce consistency
- ✅ All primitives tested (unit + a11y)

---

**Next Steps**: Run baselines → Generate inventory → Create tokens → Implement primitives → Migrate existing code → Test & document
