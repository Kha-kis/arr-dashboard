"use client";

import { HardDrive, Server } from "lucide-react";
import { usePlexIdentity } from "../../../hooks/api/usePlex";
import { getLinuxServerName, useIncognitoMode } from "../../../lib/incognito";
import { SERVICE_GRADIENTS } from "../../../lib/theme-gradients";

const plexGradient = SERVICE_GRADIENTS.plex;

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

interface PlexServerInfoWidgetProps {
	enabled: boolean;
	animationDelay?: number;
	variant?: "compact" | "detailed";
}

export const PlexServerInfoWidget = ({
	enabled,
	animationDelay = 0,
	variant = "compact",
}: PlexServerInfoWidgetProps) => {
	const [incognitoMode] = useIncognitoMode();
	const { data, isLoading, isError } = usePlexIdentity(enabled);

	if (!enabled || isLoading || isError || !data?.servers?.length) return null;

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
							background: `linear-gradient(90deg, ${plexGradient.from}, ${plexGradient.to})`,
						}}
					/>
					<div className="flex items-center gap-3 px-6 py-3">
						<div
							className="flex h-8 w-8 items-center justify-center rounded-lg"
							style={{
								background: `linear-gradient(135deg, ${plexGradient.from}20, ${plexGradient.to}20)`,
								border: `1px solid ${plexGradient.from}30`,
							}}
						>
							<Server className="h-4 w-4" style={{ color: plexGradient.from }} />
						</div>
						<div className="min-w-0">
							<h3 className="text-sm font-semibold text-foreground">Plex Server</h3>
							<div className="flex flex-wrap items-center gap-x-4 gap-y-0.5">
								{data.servers.map((server) => {
									const ver = parsePlexVersion(server.version);
									return (
										<p key={server.instanceId} className="text-xs text-muted-foreground">
											{incognitoMode ? getLinuxServerName(server.friendlyName || server.instanceName) : (server.friendlyName || server.instanceName)}
											{" · "}v{ver.display}
											{server.platform && ` · ${server.platform}`}
										</p>
									);
								})}
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
						background: `linear-gradient(90deg, ${plexGradient.from}, ${plexGradient.to})`,
					}}
				/>
				<div className="flex items-center gap-3 px-6 py-4 border-b border-border/50">
					<div
						className="flex h-8 w-8 items-center justify-center rounded-lg"
						style={{
							background: `linear-gradient(135deg, ${plexGradient.from}20, ${plexGradient.to}20)`,
							border: `1px solid ${plexGradient.from}30`,
						}}
					>
						<Server className="h-4 w-4" style={{ color: plexGradient.from }} />
					</div>
					<div>
						<h3 className="text-sm font-semibold text-foreground">Plex Servers</h3>
						<p className="text-xs text-muted-foreground">
							{data.servers.length} server{data.servers.length !== 1 ? "s" : ""} connected
						</p>
					</div>
				</div>

				<div className="divide-y divide-border/50">
					{data.servers.map((server, index) => {
						const ver = parsePlexVersion(server.version);
						return (
							<div
								key={server.instanceId}
								className="flex items-center gap-4 px-6 py-3 animate-in fade-in slide-in-from-bottom-2 duration-300"
								style={{
									animationDelay: `${index * 50}ms`,
									animationFillMode: "backwards",
								}}
							>
								<HardDrive className="h-5 w-5 text-muted-foreground" />
								<div className="flex-1 min-w-0">
									<p className="text-sm font-medium text-foreground truncate">
										{incognitoMode ? getLinuxServerName(server.friendlyName || server.instanceName) : (server.friendlyName || server.instanceName)}
									</p>
									<p className="text-xs text-muted-foreground">
										v{ver.display}
										{ver.build && ` (build ${ver.build})`}
										{server.platform && ` · ${server.platform}`}
									</p>
								</div>
								<span className="text-xs text-muted-foreground font-mono">
									{incognitoMode ? "••••••••" : server.machineId.slice(0, 8)}
								</span>
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
};
