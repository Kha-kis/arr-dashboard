/**
 * Constants for settings feature
 */

export type ServiceType =
	| "sonarr"
	| "radarr"
	| "prowlarr"
	| "lidarr"
	| "readarr"
	| "seerr"
	| "tautulli"
	| "plex"
	| "jellyfin"
	| "emby";

export const SERVICE_TYPES: ServiceType[] = [
	"sonarr",
	"radarr",
	"prowlarr",
	"lidarr",
	"readarr",
	"seerr",
	"tautulli",
	"plex",
	"jellyfin",
	"emby",
];

export const OPTION_STYLE = {
	backgroundColor: "hsl(var(--color-bg))",
	color: "hsl(var(--color-fg))",
} as const;

export const TABS = [
	"services",
	"tags",
	"account",
	"authentication",
	"appearance",
	"backup",
	"notifications",
	"system",
] as const;

export type TabType = (typeof TABS)[number];
