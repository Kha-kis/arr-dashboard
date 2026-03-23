# UI Theming System

> Reference documentation extracted from CLAUDE.md for detailed deep dives into the theming and UI system.

The application uses a centralized, three-tier color system with CSS variables for instant theme switching.

## Color Hierarchy

| Layer | Purpose | Example Use |
|-------|---------|-------------|
| **Theme Colors** | User's selected accent color (10 themes) | Focus rings, selections, primary buttons |
| **Service Colors** | Fixed colors per service type | Sonarr=cyan, Radarr=orange, Prowlarr=purple |
| **Semantic Colors** | Status indicators | success=green, warning=amber, error=red |

## Key Files

| File | Purpose |
|------|---------|
| `apps/web/src/lib/theme-gradients.ts` | Central source of truth for all color constants and utilities |
| `apps/web/src/hooks/useThemeGradient.ts` | React hook for accessing theme colors in components |
| `apps/web/src/lib/theme-input-styles.ts` | Form input styling utilities |
| `apps/web/src/providers/color-theme-provider.tsx` | React context for theme state |
| `apps/web/app/globals.css` | CSS variable definitions for each theme |

## Usage Patterns

### Theme Gradients (User's Color Preference)

Use the `useThemeGradient` hook for components that should respect the user's theme choice:

```typescript
// CORRECT: Use the hook
import { useThemeGradient } from "@/hooks/useThemeGradient";

function MyComponent() {
  const { gradient } = useThemeGradient();

  return (
    <div style={{
      borderColor: gradient.from,
      boxShadow: `0 0 0 2px ${gradient.fromLight}`,
    }}>
      Themed content
    </div>
  );
}

// WRONG: Don't use the old 2-line pattern
import { useColorTheme } from "@/providers/color-theme-provider";
import { THEME_GRADIENTS } from "@/lib/theme-gradients";
const { colorTheme } = useColorTheme();
const gradient = THEME_GRADIENTS[colorTheme]; // Deprecated pattern
```

### Service Gradients (Sonarr/Radarr/Prowlarr)

Use `getServiceGradient()` for runtime lookups, `SERVICE_GRADIENTS` for compile-time:

```typescript
import { getServiceGradient, SERVICE_GRADIENTS } from "@/lib/theme-gradients";

// Runtime lookup (service comes from props/data)
function ServiceCard({ instance }: { instance: ServiceInstance }) {
  const gradient = getServiceGradient(instance.service);
  return <div style={{ background: gradient.from }}>...</div>;
}

// Compile-time lookup (service is hardcoded)
const sonarrGradient = SERVICE_GRADIENTS.sonarr;
```

### Semantic Colors (Status Indicators)

Use `SEMANTIC_COLORS` for success/warning/error/info states:

```typescript
import { SEMANTIC_COLORS } from "@/lib/theme-gradients";

// Status badge
<span style={{
  backgroundColor: SEMANTIC_COLORS.success.bg,
  color: SEMANTIC_COLORS.success.text,
  borderColor: SEMANTIC_COLORS.success.border,
}}>
  Connected
</span>
```

### Brand Colors (External Services)

Use `BRAND_COLORS` for third-party service badges (IMDB, Rotten Tomatoes, etc.):

```typescript
import { BRAND_COLORS, RATING_COLOR } from "@/lib/theme-gradients";

// IMDB badge
<span style={{
  backgroundColor: BRAND_COLORS.imdb.bg,
  borderColor: BRAND_COLORS.imdb.border,
  color: BRAND_COLORS.imdb.text,  // #f5c518
}}>
  8.5
</span>

// Star rating color (amber/gold)
<Star style={{ color: RATING_COLOR }} />  // #fbbf24
```

**Available Brand Colors:**
| Brand | Text Color | Use Case |
|-------|------------|----------|
| `BRAND_COLORS.imdb` | #f5c518 | IMDB ratings |
| `BRAND_COLORS.rottenTomatoes` | #5d8a3a | RT ratings |
| `BRAND_COLORS.tmdb` | #01d277 | TMDB badges |
| `BRAND_COLORS.trakt` | #ed1d24 | Trakt links |
| `BRAND_COLORS.tvdb` | #26a69a | TVDB links |

### Protocol Colors (Indexer Types)

Use `PROTOCOL_COLORS` for torrent/usenet indicators:

```typescript
import { PROTOCOL_COLORS } from "@/lib/theme-gradients";

const protocolColor = indexer.protocol === "torrent"
  ? PROTOCOL_COLORS.torrent  // Orange (#f97316)
  : PROTOCOL_COLORS.usenet;  // Cyan (#06b6d4)
```

## Gradient Type Reference

```typescript
// ThemeGradient - Full gradient with opacity variants
interface ThemeGradient {
  from: string;       // Primary color
  to: string;         // Secondary color
  glow: string;       // Shadow color (rgba)
  fromLight: string;  // 10% opacity - subtle backgrounds
  fromMedium: string; // 20% opacity - hover states
  fromMuted: string;  // 30% opacity - borders
}

// ServiceGradient - Simpler, no opacity variants
interface ServiceGradient {
  from: string;
  to: string;
  glow: string;
}
```

## Helper Functions

| Function | Purpose | Example |
|----------|---------|---------|
| `getServiceGradient(service)` | Safe runtime lookup with fallback | `getServiceGradient("sonarr")` |
| `createGradientStyle(gradient, variant)` | Complete style object | `style={createGradientStyle(gradient, "icon")}` |
| `createAccentLineStyle(gradient)` | Top accent line for cards | Common card pattern |
| `createFocusRingStyle(gradient)` | Input focus styling | Form elements |
| `getInfoColor(severity, gradient)` | Theme-aware info colors | Badge/status styling |

## Import Conventions

The codebase uses **relative imports** consistently for feature modules. Only UI base components use the `@/` alias:

```typescript
// Feature components - use relative paths
import { useThemeGradient } from "../../../hooks/useThemeGradient";

// UI components - use @/ alias
import { useThemeGradient } from "@/hooks/useThemeGradient";
```

## Critical Rules

1. **Never hardcode colors** - Always use theme system constants
2. **Use `useThemeGradient` hook** - Not the old 2-line pattern
3. **Use `getServiceGradient()` for runtime lookups** - When service type is a variable
4. **Use `SERVICE_GRADIENTS.xxx` for compile-time** - When service type is known
5. **CSS variables for instant switching** - Theme colors use `var(--theme-*)` under the hood
6. **Use Premium Components** - Prefer reusable components over custom implementations

## Premium Component Library

Located in `apps/web/src/components/layout/premium-components.tsx`. Always check here before creating custom UI elements.

| Component | Purpose | Use Case |
|-----------|---------|----------|
| `PremiumTabs` | Theme-aware tabbed navigation | Multi-tab views |
| `PremiumTable` | Styled data tables | List displays |
| `PremiumTableHeader` | Table header row | Column labels |
| `PremiumTableRow` | Table body row with hover | Data rows |
| `PremiumEmptyState` | Empty/error state display | No data scenarios |
| `PremiumProgress` | Animated progress bar | Loading states |
| `ServiceBadge` | Service type indicator | Sonarr/Radarr/Prowlarr labels |
| `StatusBadge` | Status indicator | success/warning/error/info states |
| `InstanceCard` | Full instance card | Service instance displays |
| `PremiumSection` | Page section with header | Feature sections |
| `GlassmorphicCard` | Glassmorphic container | Premium card containers |
| `FilterSelect` | Styled filter dropdown | Filter controls |
| `GradientButton` | Theme-gradient button | Primary actions |
| `PremiumSkeleton` | Loading skeleton | Loading placeholders |
| `PremiumPageLoading` | Full page loader | Page transitions |

**Usage:**
```typescript
import {
  PremiumSection,
  GlassmorphicCard,
  ServiceBadge,
  StatusBadge,
} from "@/components/layout/premium-components";
```

## Z-Index Layering System

Custom z-index scale defined in Tailwind preset. Use semantic class names instead of arbitrary values:

| Class | CSS Variable | Value | Use Case |
|-------|--------------|-------|----------|
| `z-dropdown` | `--z-dropdown` | 10 | Dropdown menus |
| `z-sticky` | `--z-sticky` | 20 | Sticky headers |
| `z-fixed` | `--z-fixed` | 30 | Fixed elements |
| `z-modal-backdrop` | `--z-modal-backdrop` | 40 | Modal overlays |
| `z-modal` | `--z-modal` | 50 | Modal dialogs |
| `z-popover` | `--z-popover` | 60 | Popovers |
| `z-toast` | `--z-toast` | 70 | Toast notifications |
| `z-tooltip` | `--z-tooltip` | 80 | Tooltips |

```typescript
// CORRECT: Use semantic z-index
<div className="z-modal">...</div>

// WRONG: Arbitrary z-index values
<div className="z-[9999]">...</div>
```

## Animation Patterns

**Staggered Entrance Animation:**
```typescript
// Common pattern for lists
{items.map((item, index) => (
  <Card
    key={item.id}
    className="animate-in fade-in slide-in-from-bottom-2 duration-300"
    style={{
      animationDelay: `${index * 30}ms`,
      animationFillMode: "backwards",
    }}
  />
))}
```

**Duration Utilities:**
| Class | Duration | Use Case |
|-------|----------|----------|
| `duration-fast` | 100ms | Micro-interactions |
| `duration-normal` | 200ms | Standard transitions (default) |
| `duration-slow` | 300ms | Animations |
| `duration-slower` | 500ms | Complex animations |

## Glassmorphic Styling Pattern

Standard pattern for glass-effect cards used throughout:

```typescript
// Glassmorphic card pattern
<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm">
  {/* Content */}
</div>

// Or use the component
import { GlassmorphicCard } from "@/components/layout/premium-components";
<GlassmorphicCard padding="md">Content</GlassmorphicCard>
```

**Key classes:**
- `backdrop-blur-sm` - Subtle blur effect
- `bg-card/30` - 30% opacity card background
- `border-border/50` - 50% opacity border
- `hover:border-border/80` - Interactive hover state

## Typography Utilities

Custom text utilities from Tailwind preset:

| Class | Font | Size | Use Case |
|-------|------|------|----------|
| `text-h1` | Display (Satoshi) | 3xl + bold | Page titles |
| `text-h2` | Display (Satoshi) | 2xl + bold | Section headers |
| `text-h3` | Display (Satoshi) | xl + semibold | Subsection headers |
| `text-h4` | Display (Satoshi) | lg + semibold | Card titles |
| `text-body` | Body (DM Sans) | base | Standard text |
| `text-small` | Body (DM Sans) | sm | Secondary text |
| `text-caption` | Body (DM Sans) | xs | Labels, captions |
