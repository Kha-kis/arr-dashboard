/**
 * Premium Components - Barrel Re-export
 *
 * All components are split into category files for maintainability:
 * - premium-data-display.tsx:  Tables, Badges, Progress
 * - premium-containers.tsx:    Cards, Sections, Empty States
 * - premium-interactive.tsx:   Tabs, Selects, Buttons, Skeletons
 */

// Data Display
export { PremiumTable, PremiumTableHeader, PremiumTableRow } from "./premium-data-display";
export { ServiceBadge, StatusBadge } from "./premium-data-display";
export { PremiumProgress } from "./premium-data-display";

// Containers & Layout
export { PremiumEmptyState, PremiumSection } from "./premium-containers";
export { GlassmorphicCard, InstanceCard } from "./premium-containers";
export type { GlassmorphicCardProps } from "./premium-containers";

// Interactive & Loading
export { PremiumTabs, FilterSelect, GradientButton } from "./premium-interactive";
export { PremiumSkeleton, PremiumPageLoading } from "./premium-interactive";
export type { PremiumTab } from "./premium-interactive";
