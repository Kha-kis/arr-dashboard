"use client";

/**
 * Plex OAuth Setup Section
 *
 * Inline component shown in ServiceForm for Plex services (add and edit mode).
 * Provides "Connect with Plex" / "Reconnect with Plex" button, status indicators,
 * and server selection. Pre-fills the parent form with selected server details.
 */

import type { PlexDiscoveredServer, PlexServerConnection } from "@arr/shared";
import { Check, Globe, Loader2, Monitor, Server, Wifi } from "lucide-react";
import { useCallback, useState } from "react";
import { Alert, AlertDescription } from "../../../components/ui";
import { usePlexOAuth } from "../../../hooks/api/usePlexOAuth";
import { retrievePlexToken } from "../../../lib/api-client/plex";
import { getLinuxInstanceName, getLinuxUrl, useIncognitoMode } from "../../../lib/incognito";
import { SEMANTIC_COLORS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";

const PLEX_GRADIENT = SERVICE_GRADIENTS.plex;

interface PlexOAuthSectionProps {
	onServerSelected: (label: string, baseUrl: string, apiKey: string) => void;
	onTestConnection: () => void;
	mode: "add" | "edit";
}

/**
 * Choose the best default connection from a server's connection list.
 * Priority: reachable local > reachable non-relay > first reachable > first available.
 */
function pickBestConnection(connections: PlexServerConnection[]): PlexServerConnection | undefined {
	const reachableLocal = connections.find((c) => c.reachable && c.local && !c.relay);
	if (reachableLocal) return reachableLocal;

	const reachableNonRelay = connections.find((c) => c.reachable && !c.relay);
	if (reachableNonRelay) return reachableNonRelay;

	const firstReachable = connections.find((c) => c.reachable);
	if (firstReachable) return firstReachable;

	return connections[0];
}

export const PlexOAuthSection = ({
	onServerSelected,
	onTestConnection,
	mode,
}: PlexOAuthSectionProps) => {
	const isEdit = mode === "edit";
	const { status, servers, tokenRef, error, startOAuth, cancel } = usePlexOAuth();
	const [isIncognito] = useIncognitoMode();
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const [consuming, setConsuming] = useState(false);
	const [selectedUnreachable, setSelectedUnreachable] = useState(false);

	const handleSelectConnection = useCallback(
		async (server: PlexDiscoveredServer, connection: PlexServerConnection) => {
			if (!tokenRef || consuming) return;

			const key = `${server.clientIdentifier}:${connection.uri}`;
			setSelectedKey(key);
			setSelectedUnreachable(!connection.reachable);
			setConsuming(true);
			try {
				const { authToken } = await retrievePlexToken(tokenRef);
				onServerSelected(server.name, connection.uri, authToken);
				// Auto-trigger connection test after form is pre-filled
				setTimeout(onTestConnection, 100);
			} catch {
				// Token expired or retrieval failed — revert selection and restart flow
				setSelectedKey(null);
				setSelectedUnreachable(false);
				cancel();
				startOAuth();
			} finally {
				setConsuming(false);
			}
		},
		[tokenRef, consuming, onServerSelected, onTestConnection, cancel, startOAuth],
	);

	// Idle / error / cancelled — show the sign-in button
	if (status === "idle" || status === "error" || status === "cancelled") {
		return (
			<div className="space-y-3">
				<button
					type="button"
					onClick={startOAuth}
					className="flex w-full items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition-all duration-200 hover:brightness-110"
					style={{
						borderColor: PLEX_GRADIENT.from,
						backgroundColor: `${PLEX_GRADIENT.from}15`,
						color: PLEX_GRADIENT.from,
					}}
				>
					<Server className="h-4 w-4" />
					{isEdit ? "Reconnect with Plex" : "Connect with Plex"}
				</button>

				{status === "error" && error && (
					<Alert variant="danger">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				)}

				{status === "cancelled" && (
					<p className="text-center text-xs text-muted-foreground">Plex sign-in was cancelled.</p>
				)}

				<Divider text={isEdit ? "or edit manually" : "or enter manually"} />
			</div>
		);
	}

	// Pending / polling / discovering — show loading state
	if (status === "pending" || status === "polling" || status === "discovering") {
		return (
			<div className="space-y-3">
				<div className="flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-card/30 px-3 py-2.5 sm:px-4 sm:py-3">
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" style={{ color: PLEX_GRADIENT.from }} />
						{status === "pending" && "Connecting to Plex..."}
						{status === "polling" && "Waiting for authorization..."}
						{status === "discovering" && "Discovering servers..."}
					</div>
					<button
						type="button"
						onClick={cancel}
						className="text-xs text-muted-foreground hover:text-foreground"
					>
						Cancel
					</button>
				</div>

				<Divider text={isEdit ? "or edit manually" : "or enter manually"} />
			</div>
		);
	}

	// Done — show discovered servers
	if (status === "done") {
		if (servers.length === 0) {
			return (
				<div className="space-y-3">
					<Alert variant="default">
						<AlertDescription>
							No Plex servers found on your account. You can {isEdit ? "edit" : "add one"} manually
							below.
						</AlertDescription>
					</Alert>
					<button
						type="button"
						onClick={startOAuth}
						className="text-xs text-muted-foreground underline hover:text-foreground"
					>
						Try again
					</button>
					<Divider text={isEdit ? "or edit manually" : "or enter manually"} />
				</div>
			);
		}

		return (
			<div className="space-y-3">
				<p className="text-xs text-muted-foreground">
					{servers.length === 1 ? "1 server found" : `${servers.length} servers found`} — select one
					to auto-fill the form:
				</p>

				<div className="space-y-3">
					{servers.map((server) => {
						const best = pickBestConnection(server.connections);

						return (
							<div key={server.clientIdentifier} className="space-y-1">
								<div className="flex items-center gap-2 px-1">
									<Monitor className="h-3.5 w-3.5 shrink-0" style={{ color: PLEX_GRADIENT.from }} />
									<span className="truncate text-xs font-medium">
										{isIncognito ? getLinuxInstanceName(server.name) : server.name}
									</span>
									{server.version && !isIncognito && (
										<span className="shrink-0 text-xs text-muted-foreground">
											v{server.version}
										</span>
									)}
								</div>

								<div className="space-y-1">
									{server.connections.map((conn) => {
										const key = `${server.clientIdentifier}:${conn.uri}`;
										const isSelected = selectedKey === key;
										const isBest = conn === best;

										return (
											<button
												key={key}
												type="button"
												onClick={() => handleSelectConnection(server, conn)}
												className="flex w-full items-center gap-1.5 rounded-md border px-2 py-2 text-left text-[11px] transition-all duration-200 hover:bg-accent/50 sm:gap-2 sm:px-3 sm:py-1.5 sm:text-xs"
												style={
													isSelected
														? {
																borderColor: PLEX_GRADIENT.from,
																backgroundColor: `${PLEX_GRADIENT.from}10`,
															}
														: undefined
												}
											>
												<ConnectionBadge connection={conn} />
												<span className="min-w-0 flex-1 truncate">
													{isIncognito ? getLinuxUrl(conn.uri) : conn.uri}
												</span>
												{isBest && !isSelected && (
													<span className="shrink-0 text-[10px] text-muted-foreground">
														recommended
													</span>
												)}
												{isSelected && (
													<Check
														className="h-3 w-3 shrink-0"
														style={{ color: PLEX_GRADIENT.from }}
													/>
												)}
												{conn.reachable ? (
													<span
														className="shrink-0"
														style={{ color: SEMANTIC_COLORS.success.text }}
													>
														reachable
													</span>
												) : (
													<span
														className="shrink-0"
														style={{ color: SEMANTIC_COLORS.warning.text }}
													>
														unreachable
													</span>
												)}
											</button>
										);
									})}
								</div>
							</div>
						);
					})}
				</div>

				{selectedUnreachable && selectedKey && (
					<Alert variant="danger">
						<AlertDescription>
							This connection was unreachable during discovery. You may need to adjust the Base URL
							below before saving. Use Test connection to verify.
						</AlertDescription>
					</Alert>
				)}

				{isEdit && selectedKey && !selectedUnreachable && (
					<Alert variant="default">
						<AlertDescription>Updated — click Save changes to apply.</AlertDescription>
					</Alert>
				)}

				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={() => {
							setSelectedKey(null);
							setSelectedUnreachable(false);
							startOAuth();
						}}
						className="text-xs text-muted-foreground underline hover:text-foreground"
					>
						Re-scan
					</button>
				</div>

				<Divider text={isEdit ? "or edit manually" : "or enter manually"} />
			</div>
		);
	}

	return null;
};

/** Visual divider with configurable text */
const Divider = ({ text = "or enter manually" }: { text?: string }) => (
	<div className="relative">
		<div className="absolute inset-0 flex items-center">
			<span className="w-full border-t border-border" />
		</div>
		<div className="relative flex justify-center text-xs uppercase">
			<span className="bg-card px-2 text-muted-foreground">{text}</span>
		</div>
	</div>
);

/** Connection type label and icon */
function getConnectionMeta(conn: PlexServerConnection): {
	label: string;
	icon: typeof Wifi;
	secure: boolean;
} {
	const secure = conn.uri.startsWith("https://");
	if (conn.local) return { label: "Local", icon: Wifi, secure };
	if (conn.relay) return { label: "Relay", icon: Globe, secure };
	return { label: "Remote", icon: Globe, secure };
}

/** Badge showing connection type, protocol, and icon */
const ConnectionBadge = ({ connection }: { connection: PlexServerConnection }) => {
	const { label, icon: Icon, secure } = getConnectionMeta(connection);
	return (
		<span className="inline-flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
			<Icon className="h-2.5 w-2.5" />
			{label}
			{secure && (
				<span className="text-[9px]" style={{ color: SEMANTIC_COLORS.success.text }}>
					SSL
				</span>
			)}
		</span>
	);
};
