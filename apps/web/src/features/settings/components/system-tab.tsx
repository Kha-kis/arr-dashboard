"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
	RefreshCw,
	AlertTriangle,
	Info,
	Database,
	Server,
	Clock,
	Cpu,
	Network,
	Loader2,
	Save,
	ChevronDown,
	Globe,
} from "lucide-react";
import { apiRequest } from "../../../lib/api-client/base";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import {
	PremiumSection,
	GlassmorphicCard,
	PremiumSkeleton,
} from "../../../components/layout";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { cn } from "../../../lib/utils";

interface SystemSettings {
	apiPort: number;
	webPort: number;
	listenAddress: string;
	appName: string;
	externalUrl: string | null;
	effectiveApiPort: number;
	effectiveWebPort: number;
	effectiveListenAddress: string;
	requiresRestart: boolean;
	updatedAt: string;
}

interface SystemSettingsResponse {
	success: boolean;
	data: SystemSettings;
	message?: string;
}

interface SystemInfo {
	version: string;
	database: {
		type: string;
		host: string | null;
	};
	runtime: {
		nodeVersion: string;
		platform: string;
		uptime: number;
	};
}

interface SystemInfoResponse {
	success: boolean;
	data: SystemInfo;
}

async function getSystemSettings(): Promise<SystemSettingsResponse> {
	return apiRequest<SystemSettingsResponse>("/api/system/settings");
}

async function getSystemInfo(): Promise<SystemInfoResponse> {
	return apiRequest<SystemInfoResponse>("/api/system/info");
}

function formatUptime(seconds: number): string {
	const days = Math.floor(seconds / 86400);
	const hours = Math.floor((seconds % 86400) / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);

	const parts = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	if (parts.length === 0) parts.push(`${seconds}s`);

	return parts.join(" ");
}

async function updateSystemSettings(data: {
	apiPort?: number;
	webPort?: number;
	listenAddress?: string;
	appName?: string;
	externalUrl?: string | null;
}): Promise<SystemSettingsResponse> {
	return apiRequest<SystemSettingsResponse>("/api/system/settings", {
		method: "PUT",
		json: data,
	});
}

async function restartSystem(): Promise<{ success: boolean; message: string }> {
	return apiRequest<{ success: boolean; message: string }>("/api/system/restart", {
		method: "POST",
	});
}

/**
 * Premium System Info Card
 *
 * Displays a single system metric with:
 * - Theme-aware icon styling
 * - Glassmorphic background
 * - Staggered entrance animation
 */
interface SystemInfoCardProps {
	icon: React.ReactNode;
	label: string;
	value: string;
	subtitle?: string;
	animationDelay?: number;
}

function SystemInfoCard({ icon, label, value, subtitle, animationDelay = 0 }: SystemInfoCardProps) {
	return (
		<div
			className="flex items-start gap-3 p-4 rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs transition-all duration-300 hover:border-border/80 animate-in fade-in slide-in-from-bottom-2"
			style={{
				animationDelay: `${animationDelay}ms`,
				animationFillMode: "backwards",
			}}
		>
			{icon}
			<div className="min-w-0 flex-1">
				<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
					{label}
				</p>
				<p className="text-sm font-semibold text-foreground mt-0.5 truncate">
					{value}
				</p>
				{subtitle && (
					<p className="text-xs text-muted-foreground mt-0.5 font-mono truncate">
						{subtitle}
					</p>
				)}
			</div>
		</div>
	);
}

/**
 * Premium System Tab
 *
 * System configuration with:
 * - Glassmorphic info cards with theme gradients
 * - Premium restart warning banner
 * - Theme-aware port/address preset buttons
 * - Staggered animations throughout
 */
export function SystemTab() {
	const { gradient: themeGradient } = useThemeGradient();
	const queryClient = useQueryClient();
	const [apiPort, setApiPort] = useState(3001);
	const [webPort, setWebPort] = useState(3000);
	const [listenAddress, setListenAddress] = useState("0.0.0.0");
	const [externalUrl, setExternalUrl] = useState("");
	const [hasChanges, setHasChanges] = useState(false);
	const [isDockerInfoOpen, setIsDockerInfoOpen] = useState(false);

	const { data: settings, isLoading } = useQuery({
		queryKey: ["system-settings"],
		queryFn: getSystemSettings,
	});

	const { data: systemInfo } = useQuery({
		queryKey: ["system-info"],
		queryFn: getSystemInfo,
		refetchInterval: 60000,
	});

	const updateMutation = useMutation({
		mutationFn: updateSystemSettings,
		onSuccess: (response) => {
			queryClient.invalidateQueries({ queryKey: ["system-settings"] });
			toast.success(response.message || "Settings saved");
			setHasChanges(false);
		},
		onError: (error) => {
			toast.error(error instanceof Error ? error.message : "Failed to save settings");
		},
	});

	const restartMutation = useMutation({
		mutationFn: restartSystem,
		onSuccess: (response) => {
			toast.success(response.message || "Restart initiated");
		},
		onError: (error) => {
			toast.error(error instanceof Error ? error.message : "Failed to restart");
		},
	});

	useEffect(() => {
		if (settings?.data) {
			setApiPort(settings.data.apiPort);
			setWebPort(settings.data.webPort);
			setListenAddress(settings.data.listenAddress || "0.0.0.0");
			setExternalUrl(settings.data.externalUrl || "");
		}
	}, [settings?.data]);

	const checkForChanges = (
		newApiPort: number,
		newWebPort: number,
		newListenAddress: string,
		newExternalUrl: string
	) => {
		const originalApiPort = settings?.data?.apiPort ?? 3001;
		const originalWebPort = settings?.data?.webPort ?? 3000;
		const originalListenAddress = settings?.data?.listenAddress ?? "0.0.0.0";
		const originalExternalUrl = settings?.data?.externalUrl ?? "";

		setHasChanges(
			newApiPort !== originalApiPort ||
			newWebPort !== originalWebPort ||
			newListenAddress !== originalListenAddress ||
			newExternalUrl !== originalExternalUrl
		);
	};

	const handleApiPortChange = (value: string) => {
		const port = Number.parseInt(value, 10) || 0;
		setApiPort(port);
		checkForChanges(port, webPort, listenAddress, externalUrl);
	};

	const handleWebPortChange = (value: string) => {
		const port = Number.parseInt(value, 10) || 0;
		setWebPort(port);
		checkForChanges(apiPort, port, listenAddress, externalUrl);
	};

	const handleListenAddressChange = (value: string) => {
		setListenAddress(value);
		checkForChanges(apiPort, webPort, value, externalUrl);
	};

	const handleExternalUrlChange = (value: string) => {
		setExternalUrl(value);
		checkForChanges(apiPort, webPort, listenAddress, value);
	};

	const handleSave = () => {
		if (apiPort < 1 || apiPort > 65535) {
			toast.error("API Port must be between 1 and 65535");
			return;
		}
		if (webPort < 1 || webPort > 65535) {
			toast.error("Web Port must be between 1 and 65535");
			return;
		}
		if (apiPort === webPort) {
			toast.error("API Port and Web Port cannot be the same");
			return;
		}
		// Validate external URL if provided
		if (externalUrl) {
			try {
				const url = new URL(externalUrl);
				if (!["http:", "https:"].includes(url.protocol)) {
					toast.error("External URL must use http or https protocol");
					return;
				}
			} catch {
				toast.error("External URL must be a valid URL (e.g., https://arr.example.com)");
				return;
			}
		}
		// Send null for empty string to clear the value
		updateMutation.mutate({
			apiPort,
			webPort,
			listenAddress,
			externalUrl: externalUrl || null,
		});
	};

	const handleRestart = () => {
		if (confirm("Are you sure you want to restart the application? This will temporarily interrupt service.")) {
			restartMutation.mutate();
		}
	};

	if (isLoading) {
		return (
			<div className="space-y-6">
				<PremiumSkeleton className="h-10 w-48" />
				<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
					{[...Array(4)].map((_, i) => (
						<PremiumSkeleton key={i} className="h-24" />
					))}
				</div>
				<PremiumSkeleton className="h-64" />
				<PremiumSkeleton className="h-48" />
			</div>
		);
	}

	const requiresRestart = settings?.data?.requiresRestart || hasChanges;

	return (
		<div className="space-y-6">
			{/* System Information Section */}
			{systemInfo?.data && (
				<PremiumSection
					title="System Information"
					description="Application version and runtime details"
					icon={Cpu}
				>
					<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
						<SystemInfoCard
							icon={
								<div
									className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
									style={{
										background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
										border: `1px solid ${themeGradient.from}30`,
									}}
								>
									<Server className="h-5 w-5" style={{ color: themeGradient.from }} />
								</div>
							}
							label="Version"
							value={`v${systemInfo.data.version}`}
							animationDelay={0}
						/>

						<SystemInfoCard
							icon={
								<div
									className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
									style={{
										background: `linear-gradient(135deg, ${SEMANTIC_COLORS.success.from}20, ${SEMANTIC_COLORS.success.to}20)`,
										border: `1px solid ${SEMANTIC_COLORS.success.from}30`,
									}}
								>
									<Database className="h-5 w-5" style={{ color: SEMANTIC_COLORS.success.from }} />
								</div>
							}
							label="Database"
							value={systemInfo.data.database.type}
							subtitle={systemInfo.data.database.host || undefined}
							animationDelay={50}
						/>

						<SystemInfoCard
							icon={
								<div
									className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
									style={{
										background: `linear-gradient(135deg, ${SEMANTIC_COLORS.info.from}20, ${SEMANTIC_COLORS.info.to}20)`,
										border: `1px solid ${SEMANTIC_COLORS.info.from}30`,
									}}
								>
									<Info className="h-5 w-5" style={{ color: SEMANTIC_COLORS.info.from }} />
								</div>
							}
							label="Node.js"
							value={systemInfo.data.runtime.nodeVersion}
							animationDelay={100}
						/>

						<SystemInfoCard
							icon={
								<div
									className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
									style={{
										background: `linear-gradient(135deg, ${SEMANTIC_COLORS.warning.from}20, ${SEMANTIC_COLORS.warning.to}20)`,
										border: `1px solid ${SEMANTIC_COLORS.warning.from}30`,
									}}
								>
									<Clock className="h-5 w-5" style={{ color: SEMANTIC_COLORS.warning.from }} />
								</div>
							}
							label="Uptime"
							value={formatUptime(systemInfo.data.runtime.uptime)}
							animationDelay={150}
						/>
					</div>
				</PremiumSection>
			)}

			{/* Restart Warning Banner */}
			{requiresRestart && (
				<div
					className="flex items-start gap-3 rounded-xl p-4 animate-in fade-in slide-in-from-bottom-2"
					style={{
						backgroundColor: SEMANTIC_COLORS.warning.bg,
						border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
					}}
				>
					<div
						className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
						style={{
							background: `linear-gradient(135deg, ${SEMANTIC_COLORS.warning.from}20, ${SEMANTIC_COLORS.warning.to}20)`,
							border: `1px solid ${SEMANTIC_COLORS.warning.from}30`,
						}}
					>
						<AlertTriangle className="h-5 w-5" style={{ color: SEMANTIC_COLORS.warning.from }} />
					</div>
					<div className="flex-1 min-w-0">
						<p className="font-semibold text-foreground">
							Restart Required
						</p>
						<p className="text-sm text-muted-foreground mt-0.5">
							Changes to port or listen address settings require a container restart to take effect.
						</p>
					</div>
					{!hasChanges && (
						<Button
							onClick={handleRestart}
							disabled={restartMutation.isPending}
							className="gap-2 shrink-0"
							style={{
								background: `linear-gradient(135deg, ${SEMANTIC_COLORS.warning.from}, ${SEMANTIC_COLORS.warning.to})`,
								boxShadow: `0 4px 12px -4px ${SEMANTIC_COLORS.warning.glow}`,
							}}
						>
							<RefreshCw className={cn("h-4 w-4", restartMutation.isPending && "animate-spin")} />
							{restartMutation.isPending ? "Restarting..." : "Restart Now"}
						</Button>
					)}
				</div>
			)}

			{/* Port Configuration Section */}
			<PremiumSection
				title="Port Configuration"
				description="Internal container ports for the web UI and API server"
				icon={Network}
			>
				<div className="space-y-6">
					<div className="grid gap-6 sm:grid-cols-2 max-w-2xl">
						{/* Web UI Port */}
						<div className="space-y-2">
							<label
								htmlFor="webPort"
								className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
							>
								Web UI Port
							</label>
							<Input
								id="webPort"
								type="number"
								min="1"
								max="65535"
								value={webPort}
								onChange={(e) => handleWebPortChange(e.target.value)}
								className="bg-card/30 border-border/50"
							/>
							<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
								<Info className="h-3 w-3" />
								Running on:{" "}
								<code className="px-1.5 py-0.5 bg-card/50 rounded font-mono text-foreground">
									{settings?.data?.effectiveWebPort}
								</code>
							</p>
						</div>

						{/* API Port */}
						<div className="space-y-2">
							<label
								htmlFor="apiPort"
								className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
							>
								API Port
							</label>
							<Input
								id="apiPort"
								type="number"
								min="1"
								max="65535"
								value={apiPort}
								onChange={(e) => handleApiPortChange(e.target.value)}
								className="bg-card/30 border-border/50"
							/>
							<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
								<Info className="h-3 w-3" />
								Running on:{" "}
								<code className="px-1.5 py-0.5 bg-card/50 rounded font-mono text-foreground">
									{settings?.data?.effectiveApiPort}
								</code>
							</p>
						</div>
					</div>

					{/* Port Info Card */}
					<GlassmorphicCard padding="md">
						<div className="flex gap-3">
							<div
								className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
									border: `1px solid ${themeGradient.from}30`,
								}}
							>
								<Info className="h-5 w-5" style={{ color: themeGradient.from }} />
							</div>
							<div className="space-y-3 text-sm flex-1">
								<p className="font-semibold text-foreground">
									How port configuration works
								</p>
								<ul className="text-muted-foreground space-y-1 list-disc list-inside">
									<li>Change ports here and <strong className="text-foreground">restart the container</strong> to apply</li>
									<li>Environment variables (API_PORT, PORT) override these settings</li>
									<li>Priority: Environment variable → Database → Default</li>
								</ul>

								{/* Expandable Docker Info */}
								<button
									type="button"
									onClick={() => setIsDockerInfoOpen(!isDockerInfoOpen)}
									className="flex items-center gap-1.5 text-sm font-medium transition-colors hover:text-foreground"
									style={{ color: themeGradient.from }}
								>
									<ChevronDown
										className={cn(
											"h-4 w-4 transition-transform",
											isDockerInfoOpen && "rotate-180"
										)}
									/>
									Docker port mapping info
								</button>

								{isDockerInfoOpen && (
									<div className="space-y-2 animate-in fade-in slide-in-from-top-2 duration-200">
										<p className="text-muted-foreground">
											These are <em>internal</em> container ports (default: 3000). To access on a different host port:
										</p>
										<pre
											className="text-xs rounded-lg p-3 overflow-x-auto font-mono"
											style={{
												backgroundColor: `${themeGradient.from}10`,
												border: `1px solid ${themeGradient.from}20`,
											}}
										>
{`# Default (access on port 3000)
-p 3000:3000

# Custom host port (access on port 8080)
-p 8080:3000   # host:container

# docker-compose.yml
ports:
  - "3000:3000"  # default
  - "8080:3000"  # or custom host port`}
										</pre>
									</div>
								)}
							</div>
						</div>
					</GlassmorphicCard>
				</div>
			</PremiumSection>

			{/* Listen Address Section */}
			<PremiumSection
				title="Listen Address"
				description="Network interface binding address for the application"
				icon={Network}
			>
				<div className="space-y-6">
					{/* Quick Select Presets */}
					<div className="space-y-3">
						<label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
							Quick Select
						</label>
						<div className="flex flex-wrap gap-2">
							{[
								{ value: "0.0.0.0", label: "0.0.0.0", desc: "All interfaces (Docker)" },
								{ value: "127.0.0.1", label: "127.0.0.1", desc: "Localhost only" },
								{ value: "::", label: "::", desc: "All IPv6" },
							].map((preset) => {
								const isSelected = listenAddress === preset.value;
								return (
									<button
										key={preset.value}
										type="button"
										onClick={() => handleListenAddressChange(preset.value)}
										className={cn(
											"relative px-4 py-2.5 rounded-xl text-sm font-medium transition-all duration-300",
											"border",
											isSelected
												? "text-foreground border-transparent"
												: "text-muted-foreground border-border/50 bg-card/30 hover:border-border hover:text-foreground"
										)}
										style={
											isSelected
												? {
														background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
														border: `1px solid ${themeGradient.from}40`,
													}
												: undefined
										}
									>
										<code className="font-mono">{preset.label}</code>
										<span className="ml-2 text-xs opacity-75">({preset.desc})</span>
									</button>
								);
							})}
						</div>
					</div>

					{/* Custom IP Address Input */}
					<div className="max-w-sm space-y-2">
						<label
							htmlFor="listenAddress"
							className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
						>
							Custom IP Address
						</label>
						<Input
							id="listenAddress"
							type="text"
							value={listenAddress}
							onChange={(e) => handleListenAddressChange(e.target.value)}
							placeholder="e.g., 192.168.1.100"
							className="bg-card/30 border-border/50 font-mono"
						/>
						<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
							<Info className="h-3 w-3" />
							Running on:{" "}
							<code className="px-1.5 py-0.5 bg-card/50 rounded font-mono text-foreground">
								{settings?.data?.effectiveListenAddress}
							</code>
						</p>
					</div>

					{/* Docker Warning */}
					<div
						className="rounded-xl p-4"
						style={{
							backgroundColor: SEMANTIC_COLORS.warning.bg,
							border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
						}}
					>
						<div className="flex gap-3">
							<div
								className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
								style={{
									background: `linear-gradient(135deg, ${SEMANTIC_COLORS.warning.from}20, ${SEMANTIC_COLORS.warning.to}20)`,
									border: `1px solid ${SEMANTIC_COLORS.warning.from}30`,
								}}
							>
								<AlertTriangle className="h-5 w-5" style={{ color: SEMANTIC_COLORS.warning.from }} />
							</div>
							<div className="space-y-2 text-sm">
								<p className="font-semibold text-foreground">
									Important for Docker users
								</p>
								<ul className="text-muted-foreground space-y-1 list-disc list-inside">
									<li>
										<code className="text-xs px-1.5 py-0.5 bg-card/50 rounded font-mono">0.0.0.0</code> is{" "}
										<strong className="text-foreground">required</strong> for Docker containers
									</li>
									<li>
										<code className="text-xs px-1.5 py-0.5 bg-card/50 rounded font-mono">127.0.0.1</code>{" "}
										restricts access to localhost only
									</li>
									<li>
										Changing this requires a <strong className="text-foreground">container restart</strong>
									</li>
								</ul>
							</div>
						</div>
					</div>
				</div>
			</PremiumSection>

			{/* External URL Section */}
			<PremiumSection
				title="External URL"
				description="Configure the public URL for accessing this application"
				icon={Globe}
			>
				<div className="space-y-6">
					<div className="max-w-xl space-y-2">
						<label
							htmlFor="externalUrl"
							className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
						>
							External URL
						</label>
						<Input
							id="externalUrl"
							type="url"
							value={externalUrl}
							onChange={(e) => handleExternalUrlChange(e.target.value)}
							placeholder="https://arr.example.com"
							className="bg-card/30 border-border/50"
						/>
						<p className="text-xs text-muted-foreground">
							Leave empty to auto-detect from browser. Set this if you're behind a reverse proxy.
						</p>
					</div>

					<GlassmorphicCard padding="md">
						<div className="flex gap-3">
							<div
								className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
									border: `1px solid ${themeGradient.from}30`,
								}}
							>
								<Info className="h-5 w-5" style={{ color: themeGradient.from }} />
							</div>
							<div className="space-y-2 text-sm">
								<p className="font-semibold text-foreground">
									When to set this
								</p>
								<ul className="text-muted-foreground space-y-1 list-disc list-inside">
									<li>Behind a reverse proxy (Nginx, Traefik, Caddy)</li>
									<li>Using a custom domain name</li>
									<li>Accessing via HTTPS with SSL termination</li>
									<li>OIDC authentication requires correct callback URLs</li>
								</ul>
							</div>
						</div>
					</GlassmorphicCard>
				</div>
			</PremiumSection>

			{/* Save Button */}
			<div
				className="flex items-center gap-4 animate-in fade-in slide-in-from-bottom-2 duration-500"
				style={{ animationDelay: "300ms", animationFillMode: "backwards" }}
			>
				<Button
					onClick={handleSave}
					disabled={!hasChanges || updateMutation.isPending}
					className="gap-2"
					style={{
						background: hasChanges
							? `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`
							: undefined,
						boxShadow: hasChanges
							? `0 4px 12px -4px ${themeGradient.glow}`
							: undefined,
					}}
				>
					{updateMutation.isPending ? (
						<>
							<Loader2 className="h-4 w-4 animate-spin" />
							Saving...
						</>
					) : (
						<>
							<Save className="h-4 w-4" />
							Save Changes
						</>
					)}
				</Button>

				{requiresRestart && hasChanges && (
					<p className="text-sm text-muted-foreground animate-in fade-in duration-300">
						Save changes first, then restart to apply.
					</p>
				)}
			</div>
		</div>
	);
}
