import { AsyncLocalStorage } from "node:async_hooks";

const SOURCES = [
	"primary-inventory",
	"library-poster",
	"arr-library",
	"plex-sections",
	"plex-watch",
	"jellyfin-watch",
	"plex-series",
	"jellyfin-series",
	"plex-on-deck",
	"jellyfin-on-deck",
	"plex-recent",
	"jellyfin-recent",
	"pulse",
	"dashboard",
	"qui",
	"seerr",
	"other-http",
	"unscoped",
] as const;
export type RuntimeReadSource = (typeof SOURCES)[number];
const sources = new Set<unknown>(SOURCES);
const scopes = new AsyncLocalStorage<RuntimeReadSource>();

/** Server-declared patterns only: neither route text nor request values enter the scope. */
export function classifyRuntimeReadRoute(declaredRoute: string): RuntimeReadSource {
	if (typeof declaredRoute !== "string") return "other-http";
	const route = declaredRoute.startsWith("/api/") ? declaredRoute.slice(4) : declaredRoute;
	const prefixes: ReadonlyArray<readonly [string, RuntimeReadSource]> = [
		["/library/provider-inventory", "primary-inventory"],
		["/library/poster", "library-poster"],
		["/library", "arr-library"],
		["/plex/sections", "plex-sections"],
		["/plex/watch-enrichment", "plex-watch"],
		["/jellyfin/watch-enrichment", "jellyfin-watch"],
		["/plex/series-progress", "plex-series"],
		["/jellyfin/series-progress", "jellyfin-series"],
		["/plex/on-deck", "plex-on-deck"],
		["/jellyfin/on-deck", "jellyfin-on-deck"],
		["/plex/recently-added", "plex-recent"],
		["/jellyfin/recently-added", "jellyfin-recent"],
		["/pulse", "pulse"],
		["/dashboard", "dashboard"],
		["/qui", "qui"],
		["/seerr", "seerr"],
	];
	return (
		prefixes.find(([prefix]) => route === prefix || route.startsWith(`${prefix}/`))?.[1] ??
		"other-http"
	);
}

/** Observation only: preserve the exact synchronous value, promise, or thrown object. */
export function withRuntimeReadSource<T>(source: RuntimeReadSource, operation: () => T): T {
	return scopes.run(sources.has(source) ? source : "unscoped", operation);
}

export function getRuntimeReadSource(): RuntimeReadSource {
	return scopes.getStore() ?? "unscoped";
}
