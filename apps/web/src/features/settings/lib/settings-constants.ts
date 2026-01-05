/**
 * Constants for settings feature
 */

export type ServiceType = "sonarr" | "radarr" | "prowlarr";

export const SERVICE_TYPES: ServiceType[] = ["sonarr", "radarr", "prowlarr"];

/**
 * Base select classes without focus colors.
 * Components should apply theme-aware focus colors via inline styles.
 * @see lib/theme-input-styles.ts for focus style utilities
 */
export const SELECT_CLASS =
	"w-full rounded-lg border border-border bg-bg-subtle px-3 py-2 text-sm text-fg transition-all duration-200 hover:border-border/80 focus:outline-none";

export const OPTION_STYLE = {
	backgroundColor: "hsl(var(--color-bg))",
	color: "hsl(var(--color-fg))",
} as const;

export const TABS = ["services", "tags", "account", "authentication", "appearance", "backup", "system"] as const;

export type TabType = (typeof TABS)[number];
