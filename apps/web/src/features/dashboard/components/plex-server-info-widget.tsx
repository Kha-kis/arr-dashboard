"use client";

import { HardDrive, Server } from "lucide-react";
import { GlassmorphicCard } from "../../../components/layout";
import { usePlexIdentity } from "../../../hooks/api/usePlex";
import { SERVICE_GRADIENTS } from "../../../lib/theme-gradients";

const plexGradient = SERVICE_GRADIENTS.plex;

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
	const { data, isLoading, isError } = usePlexIdentity(enabled);

	if (!enabled || isLoading || isError || !data?.servers?.length) return null;

	if (variant === "compact") {
		return (
			<div
				className="animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: `${animationDelay}ms`, animationFillMode: "backwards" }}
			>
				<GlassmorphicCard padding="none">
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
						<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
							{data.servers.map((server) => (
								<div key={server.instanceId} className="flex items-center gap-2">
									<span className="text-sm font-medium text-foreground">
										{server.friendlyName || server.instanceName}
									</span>
									<span className="text-xs text-muted-foreground">v{server.version}</span>
									{server.platform && (
										<span className="text-xs text-muted-foreground/70">({server.platform})</span>
									)}
								</div>
							))}
						</div>
					</div>
				</GlassmorphicCard>
			</div>
		);
	}

	// Detailed variant (for settings page)
	return (
		<div
			className="animate-in fade-in slide-in-from-bottom-4 duration-500"
			style={{ animationDelay: `${animationDelay}ms`, animationFillMode: "backwards" }}
		>
			<GlassmorphicCard padding="none">
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
					{data.servers.map((server, index) => (
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
									{server.friendlyName || server.instanceName}
								</p>
								<p className="text-xs text-muted-foreground">
									{server.instanceName} — v{server.version}
									{server.platform && ` — ${server.platform}`}
								</p>
							</div>
							<span className="text-xs text-muted-foreground font-mono">{server.machineId.slice(0, 8)}</span>
						</div>
					))}
				</div>
			</GlassmorphicCard>
		</div>
	);
};
