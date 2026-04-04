"use client";

import { HardDrive, Server } from "lucide-react";
import { useMemo } from "react";
import { useJellyfinIdentity } from "../../../hooks/api/useJellyfin";
import { usePlexIdentity } from "../../../hooks/api/usePlex";
import { getLinuxServerName, useIncognitoMode } from "../../../lib/incognito";
import { SERVICE_GRADIENTS } from "../../../lib/theme-gradients";

const plexGradient = SERVICE_GRADIENTS.plex;
const jellyfinGradient = SERVICE_GRADIENTS.jellyfin;

/**
 * Parse Plex version string (e.g. "1.42.2.10156-f737b826c") into
 * a clean display version ("1.42.2") and optional build metadata.
 */
function parsePlexVersion(raw: string): { display: string; build: string | null } {
	// Strip commit hash suffix (e.g. "-f737b826c")
	const withoutHash = raw.split("-")[0] ?? raw;
	// Split into segments: ["1", "42", "2", "10156"]
	const parts = withoutHash.split(".");
	// First 3 parts are the semantic version, 4th is internal build number
	const display = parts.slice(0, 3).join(".");
	const build = parts[3] ?? null;
	return { display: display || raw, build };
}

interface NormalizedServer {
	key: string;
	name: string;
	version: string;
	versionDisplay: string;
	versionBuild: string | null;
	platform: string;
	identifier: string;
	source: "plex" | "jellyfin";
}

interface PlexServerInfoWidgetProps {
	hasPlexInstances: boolean;
	hasJellyfinInstances: boolean;
	animationDelay?: number;
	variant?: "compact" | "detailed";
}

export const PlexServerInfoWidget = ({
	hasPlexInstances,
	hasJellyfinInstances,
	animationDelay = 0,
	variant = "compact",
}: PlexServerInfoWidgetProps) => {
	const enabled = hasPlexInstances || hasJellyfinInstances;
	const [incognitoMode] = useIncognitoMode();
	const plexQuery = usePlexIdentity(hasPlexInstances);
	const jellyfinQuery = useJellyfinIdentity(hasJellyfinInstances);

	const servers = useMemo<NormalizedServer[]>(() => {
		const result: NormalizedServer[] = [];
		for (const s of plexQuery.data?.servers ?? []) {
			const ver = parsePlexVersion(s.version);
			result.push({
				key: `plex:${s.instanceId}`,
				name: s.friendlyName || s.instanceName,
				version: s.version,
				versionDisplay: ver.display,
				versionBuild: ver.build,
				platform: s.platform ?? "",
				identifier: s.machineId,
				source: "plex",
			});
		}
		for (const s of jellyfinQuery.data ?? []) {
			result.push({
				key: `jellyfin:${s.instanceId}`,
				name: s.serverName || s.instanceName,
				version: s.version,
				versionDisplay: s.version,
				versionBuild: null,
				platform: s.operatingSystem ?? "",
				identifier: s.serverId,
				source: "jellyfin",
			});
		}
		return result;
	}, [plexQuery.data, jellyfinQuery.data]);

	const isLoading = plexQuery.isLoading || jellyfinQuery.isLoading;
	const enabledErrors = [hasPlexInstances && plexQuery.isError, hasJellyfinInstances && jellyfinQuery.isError].filter(Boolean).length;
	const enabledCount = [hasPlexInstances, hasJellyfinInstances].filter(Boolean).length;
	const isError = enabledCount > 0 && enabledErrors === enabledCount;

	// Use Jellyfin gradient when all servers are Jellyfin, Plex gradient otherwise
	const hasOnlyJellyfin = servers.length > 0 && servers.every((s) => s.source === "jellyfin");
	const gradient = hasOnlyJellyfin ? jellyfinGradient : plexGradient;

	if (!enabled || isLoading || isError || servers.length === 0) return null;

	if (variant === "compact") {
		return (
			<div
				className="animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: `${animationDelay}ms`, animationFillMode: "backwards" }}
			>
				<div className="overflow-hidden rounded-xl border border-border/30 bg-muted/10">
					<div
						className="h-0.5 w-full rounded-t-xl"
						style={{
							background: `linear-gradient(90deg, ${gradient.from}, ${gradient.to})`,
						}}
					/>
					<div className="flex items-center gap-3 px-6 py-3">
						<div
							className="flex h-8 w-8 items-center justify-center rounded-lg"
							style={{
								background: `linear-gradient(135deg, ${gradient.from}20, ${gradient.to}20)`,
								border: `1px solid ${gradient.from}30`,
							}}
						>
							<Server className="h-4 w-4" style={{ color: gradient.from }} />
						</div>
						<div className="min-w-0">
							<h3 className="text-sm font-semibold text-foreground">Media Servers</h3>
							<div className="flex flex-wrap items-center gap-x-4 gap-y-0.5">
								{servers.map((server) => (
									<p key={server.key} className="text-xs text-muted-foreground">
										{incognitoMode ? getLinuxServerName(server.name) : server.name}
										{" · "}v{server.versionDisplay}
										{server.platform && ` · ${server.platform}`}
									</p>
								))}
							</div>
						</div>
					</div>
				</div>
			</div>
		);
	}

	// Detailed variant (for settings page)
	return (
		<div
			className="animate-in fade-in slide-in-from-bottom-4 duration-500"
			style={{ animationDelay: `${animationDelay}ms`, animationFillMode: "backwards" }}
		>
			<div className="overflow-hidden rounded-xl border border-border/30 bg-muted/10">
				<div
					className="h-0.5 w-full rounded-t-xl"
					style={{
						background: `linear-gradient(90deg, ${gradient.from}, ${gradient.to})`,
					}}
				/>
				<div className="flex items-center gap-3 px-6 py-4 border-b border-border/50">
					<div
						className="flex h-8 w-8 items-center justify-center rounded-lg"
						style={{
							background: `linear-gradient(135deg, ${gradient.from}20, ${gradient.to}20)`,
							border: `1px solid ${gradient.from}30`,
						}}
					>
						<Server className="h-4 w-4" style={{ color: gradient.from }} />
					</div>
					<div>
						<h3 className="text-sm font-semibold text-foreground">Media Servers</h3>
						<p className="text-xs text-muted-foreground">
							{servers.length} server{servers.length !== 1 ? "s" : ""} connected
						</p>
					</div>
				</div>

				<div className="divide-y divide-border/50">
					{servers.map((server, index) => (
						<div
							key={server.key}
							className="flex items-center gap-4 px-6 py-3 animate-in fade-in slide-in-from-bottom-2 duration-300"
							style={{
								animationDelay: `${index * 50}ms`,
								animationFillMode: "backwards",
							}}
						>
							<HardDrive className="h-5 w-5 text-muted-foreground" />
							<div className="flex-1 min-w-0">
								<p className="text-sm font-medium text-foreground truncate">
									{incognitoMode ? getLinuxServerName(server.name) : server.name}
								</p>
								<p className="text-xs text-muted-foreground">
									v{server.versionDisplay}
									{server.versionBuild && ` (build ${server.versionBuild})`}
									{server.platform && ` · ${server.platform}`}
								</p>
							</div>
							<span className="text-[10px] text-muted-foreground/60 capitalize">{server.source}</span>
							<span className="text-xs text-muted-foreground font-mono">
								{incognitoMode ? "••••••••" : server.identifier.slice(0, 8)}
							</span>
						</div>
					))}
				</div>
			</div>
		</div>
	);
};
