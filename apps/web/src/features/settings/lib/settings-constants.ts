/**
 * Constants for settings feature
 */

export type ServiceType = "sonarr" | "radarr" | "prowlarr";

export const SERVICE_TYPES: ServiceType[] = ["sonarr", "radarr", "prowlarr"];

export const SELECT_CLASS =
	"w-full rounded-lg border border-border bg-bg-subtle px-3 py-2 text-sm text-fg hover:border-sky-500/60 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-400 focus:ring-offset-2 focus:ring-offset-bg";

export const OPTION_STYLE = {
	backgroundColor: "hsl(var(--color-bg))",
	color: "hsl(var(--color-fg))",
} as const;

export const TABS = ["services", "tags", "account", "authentication", "backup"] as const;

export type TabType = (typeof TABS)[number];
