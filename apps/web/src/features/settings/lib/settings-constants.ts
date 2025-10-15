/**
 * Constants for settings feature
 */

export type ServiceType = "sonarr" | "radarr" | "prowlarr";

export const SERVICE_TYPES: ServiceType[] = ["sonarr", "radarr", "prowlarr"];

export const SELECT_CLASS =
	"w-full rounded-lg border border-white/15 bg-slate-950/80 px-3 py-2 text-sm text-white hover:border-sky-500/60 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-400 focus:ring-offset-2 focus:ring-offset-slate-950";

export const OPTION_STYLE = {
	backgroundColor: "rgba(2, 6, 23, 0.92)",
	color: "#f1f5f9",
} as const;

export const TABS = ["services", "tags", "account", "authentication", "backup"] as const;

export type TabType = (typeof TABS)[number];
