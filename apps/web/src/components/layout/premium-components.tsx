/**
 * Premium Components - Barrel Re-export
 *
 * All components are split into category files for maintainability:
 * - premium-data-display.tsx:  Tables, Badges, Progress
 * - premium-containers.tsx:    Cards, Sections, Empty States
 * - premium-interactive.tsx:   Tabs, Selects, Buttons, Skeletons
 */

export type { AsyncStateEmptyConfig, AsyncStateViewProps } from "./async-state-view";
// Async State Composer
export { AsyncErrorCard, AsyncStateView } from "./async-state-view";
export type {
	DescribeFreshnessInput,
	FreshnessDescriptor,
	FreshnessState,
} from "./data-freshness";
// Data Freshness (shared "last updated / refreshing" indicator for polling panels)
export { DataFreshness, describeFreshness, formatRelativeTime } from "./data-freshness";
export type { DomainStatus } from "./domain-status";
// Domain Status (shared service/integration health taxonomy)
export {
	DomainStatusBadge,
	deriveNotificationChannelStatus,
	deriveServiceInstanceStatus,
	getDomainStatusMeta,
} from "./domain-status";
export type { GlassmorphicCardProps } from "./premium-containers";
// Containers & Layout
export {
	GlassmorphicCard,
	InstanceCard,
	PremiumEmptyState,
	PremiumSection,
} from "./premium-containers";
// Data Display
export {
	PremiumProgress,
	PremiumTable,
	PremiumTableHeader,
	PremiumTableRow,
	ServiceBadge,
	StatusBadge,
} from "./premium-data-display";
export type { PremiumTab } from "./premium-interactive";
// Interactive & Loading
export {
	FilterSelect,
	GradientButton,
	PremiumPageLoading,
	PremiumSkeleton,
	PremiumTabs,
} from "./premium-interactive";
