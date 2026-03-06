"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AlertTriangle,
	ChevronDown,
	Clock,
	Cpu,
	Database,
	Download,
	FileText,
	Globe,
	Info,
	Loader2,
	Lock,
	Network,
	RefreshCw,
	Save,
	ScrollText,
	Server,
	Shield,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { GlassmorphicCard, PremiumSection, PremiumSkeleton } from "../../../components/layout";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Switch } from "../../../components/ui/switch";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { apiRequest } from "../../../lib/api-client/base";
import { getErrorMessage } from "../../../lib/error-utils";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { cn } from "../../../lib/utils";

interface SystemSettings {
	apiPort: number;
	webPort: number;
	listenAddress: string;
	appName: string;
	externalUrl: string | null;
	trustProxy: boolean;
	secureCookies: boolean | null;
	effectiveApiPort: number;
	effectiveWebPort: number;
	effectiveListenAddress: string;
	effectiveTrustProxy: boolean;
	effectiveSecureCookies: boolean;
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
	logging?: {
		level: string;
		directory: string;
		maxFileSize: string;
		maxFiles: number;
	};
}

interface SystemInfoResponse {
	success: boolean;
	data: SystemInfo;
}

interface LogFile {
	name: string;
	size: number;
	modified: string;
}

interface LogFilesResponse {
	success: boolean;
	data: {
		directory: string;
		files: LogFile[];
	};
}

async function getSystemSettings(): Promise<SystemSettingsResponse> {
	return apiRequest<SystemSettingsResponse>("/api/system/settings");
}

async function getSystemInfo(): Promise<SystemInfoResponse> {
	return apiRequest<SystemInfoResponse>("/api/system/info");
}

async function getLogFiles(): Promise<LogFilesResponse> {
	return apiRequest<LogFilesResponse>("/api/system/logs");
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

function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function updateSystemSettings(data: {
	apiPort?: number;
	webPort?: number;
	listenAddress?: string;
	appName?: string;
	externalUrl?: string | null;
	trustProxy?: boolean;
	secureCookies?: boolean | null;
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
				<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
				<p className="text-sm font-semibold text-foreground mt-0.5 truncate">{value}</p>
				{subtitle && (
					<p className="text-xs text-muted-foreground mt-0.5 font-mono truncate">{subtitle}</p>
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
	const [trustProxy, setTrustProxy] = useState(false);
	const [secureCookies, setSecureCookies] = useState<boolean | null>(null);
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

	const {
		data: logFiles,
		refetch: refetchLogs,
		isError: logFilesError,
	} = useQuery({
		queryKey: ["system-logs"],
		queryFn: getLogFiles,
	});

	const updateMutation = useMutation({
		mutationFn: updateSystemSettings,
		onSuccess: (response) => {
			queryClient.invalidateQueries({ queryKey: ["system-settings"] });
			toast.success(response.message || "Settings saved");
			setHasChanges(false);
		},
		onError: (error) => {
			toast.error(getErrorMessage(error, "Failed to save settings"));
		},
	});

	const restartMutation = useMutation({
		mutationFn: restartSystem,
		onSuccess: (response) => {
			toast.success(response.message || "Restart initiated");
		},
		onError: (error) => {
			toast.error(getErrorMessage(error, "Failed to restart"));
		},
	});

	useEffect(() => {
		if (settings?.data) {
			setApiPort(settings.data.apiPort);
			setWebPort(settings.data.webPort);
			setListenAddress(settings.data.listenAddress || "0.0.0.0");
			setExternalUrl(settings.data.externalUrl || "");
			setTrustProxy(settings.data.trustProxy);
			setSecureCookies(settings.data.secureCookies);
		}
	}, [settings?.data]);

	const checkForChanges = (
		newApiPort: number,
		newWebPort: number,
		newListenAddress: string,
		newExternalUrl: string,
		newTrustProxy?: boolean,
		newSecureCookies?: boolean | null,
	) => {
		const originalApiPort = settings?.data?.apiPort ?? 3001;
		const originalWebPort = settings?.data?.webPort ?? 3000;
		const originalListenAddress = settings?.data?.listenAddress ?? "0.0.0.0";
		const originalExternalUrl = settings?.data?.externalUrl ?? "";
		const originalTrustProxy = settings?.data?.trustProxy ?? false;
		const originalSecureCookies = settings?.data?.secureCookies ?? null;

		const tp = newTrustProxy ?? trustProxy;
		const sc = newSecureCookies !== undefined ? newSecureCookies : secureCookies;

		setHasChanges(
			newApiPort !== originalApiPort ||
				newWebPort !== originalWebPort ||
				newListenAddress !== originalListenAddress ||
				newExternalUrl !== originalExternalUrl ||
				tp !== originalTrustProxy ||
				sc !== originalSecureCookies,
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
			trustProxy,
			secureCookies,
		});
	};

	const handleRestart = () => {
		if (
			confirm(
				"Are you sure you want to restart the application? This will temporarily interrupt service.",
			)
		) {
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

			{/* Logging Section */}
			<PremiumSection
				title="Logging"
				description="Log file management and configuration"
				icon={ScrollText}
			>
				<div className="space-y-4">
					{/* Logging Configuration Info */}
					{systemInfo?.data?.logging && (
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
										<FileText className="h-5 w-5" style={{ color: themeGradient.from }} />
									</div>
								}
								label="Log Level"
								value={systemInfo.data.logging.level.toUpperCase()}
								animationDelay={0}
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
								label="Max File Size"
								value={systemInfo.data.logging.maxFileSize.toUpperCase()}
								animationDelay={50}
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
								label="Max Files"
								value={String(systemInfo.data.logging.maxFiles)}
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
										<Server className="h-5 w-5" style={{ color: SEMANTIC_COLORS.warning.from }} />
									</div>
								}
								label="Log Directory"
								value={systemInfo.data.logging.directory}
								animationDelay={150}
							/>
						</div>
					)}

					{/* Log Files Table */}
					<GlassmorphicCard padding="md">
						<div className="space-y-3">
							<div className="flex items-center justify-between">
								<p className="text-sm font-semibold text-foreground">Log Files</p>
								<Button
									variant="ghost"
									size="sm"
									onClick={() => refetchLogs()}
									className="gap-1.5 text-xs"
								>
									<RefreshCw className="h-3 w-3" />
									Refresh
								</Button>
							</div>

							{logFiles?.data?.files && logFiles.data.files.length > 0 ? (
								<div className="rounded-lg border border-border/50 overflow-hidden">
									<table className="w-full text-sm">
										<thead>
											<tr className="border-b border-border/50 bg-card/50">
												<th className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
													File
												</th>
												<th className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
													Size
												</th>
												<th className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
													Modified
												</th>
												<th className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">
													Action
												</th>
											</tr>
										</thead>
										<tbody>
											{logFiles.data.files.map((file, index) => (
												<tr
													key={file.name}
													className="border-b border-border/30 last:border-0 hover:bg-card/30 transition-colors"
													style={{
														animationDelay: `${index * 30}ms`,
														animationFillMode: "backwards",
													}}
												>
													<td className="px-4 py-2.5">
														<span className="font-mono text-xs text-foreground">{file.name}</span>
													</td>
													<td className="px-4 py-2.5 text-muted-foreground text-xs">
														{formatFileSize(file.size)}
													</td>
													<td className="px-4 py-2.5 text-muted-foreground text-xs">
														{new Date(file.modified).toLocaleString()}
													</td>
													<td className="px-4 py-2.5 text-right">
														<a
															href={`/api/system/logs/download/${encodeURIComponent(file.name)}`}
															download={file.name}
															className={cn(
																"inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors",
																"border border-border/50 hover:border-border hover:bg-card/50 text-muted-foreground hover:text-foreground",
															)}
														>
															<Download className="h-3 w-3" />
															Download
														</a>
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							) : logFilesError ? (
								<p className="text-sm text-destructive py-4 text-center">
									Failed to load log files
								</p>
							) : (
								<p className="text-sm text-muted-foreground py-4 text-center">No log files found</p>
							)}
						</div>
					</GlassmorphicCard>
				</div>
			</PremiumSection>

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
						<p className="font-semibold text-foreground">Restart Required</p>
						<p className="text-sm text-muted-foreground mt-0.5">
							Changes to port, listen address, or proxy security settings require a restart to take
							effect.
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
								<p className="font-semibold text-foreground">How port configuration works</p>
								<ul className="text-muted-foreground space-y-1 list-disc list-inside">
									<li>
										Change ports here and{" "}
										<strong className="text-foreground">restart the container</strong> to apply
									</li>
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
										className={cn("h-4 w-4 transition-transform", isDockerInfoOpen && "rotate-180")}
									/>
									Docker port mapping info
								</button>

								{isDockerInfoOpen && (
									<div className="space-y-2 animate-in fade-in slide-in-from-top-2 duration-200">
										<p className="text-muted-foreground">
											These are <em>internal</em> container ports (default: 3000). To access on a
											different host port:
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
												: "text-muted-foreground border-border/50 bg-card/30 hover:border-border hover:text-foreground",
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
								<AlertTriangle
									className="h-5 w-5"
									style={{ color: SEMANTIC_COLORS.warning.from }}
								/>
							</div>
							<div className="space-y-2 text-sm">
								<p className="font-semibold text-foreground">Important for Docker users</p>
								<ul className="text-muted-foreground space-y-1 list-disc list-inside">
									<li>
										<code className="text-xs px-1.5 py-0.5 bg-card/50 rounded font-mono">
											0.0.0.0
										</code>{" "}
										is <strong className="text-foreground">required</strong> for Docker containers
									</li>
									<li>
										<code className="text-xs px-1.5 py-0.5 bg-card/50 rounded font-mono">
											127.0.0.1
										</code>{" "}
										restricts access to localhost only
									</li>
									<li>
										Changing this requires a{" "}
										<strong className="text-foreground">container restart</strong>
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
							Leave empty to auto-detect from browser. Set this if you&apos;re behind a reverse
							proxy.
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
								<p className="font-semibold text-foreground">When to set this</p>
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

			{/* Reverse Proxy Security Section */}
			<PremiumSection
				title="Reverse Proxy Security"
				description="Configure trust settings when running behind a reverse proxy"
				icon={Shield}
			>
				<div className="space-y-6">
					{/* Trust Proxy Toggle */}
					<div className="flex items-start justify-between gap-6 max-w-2xl">
						<div className="space-y-1">
							<label htmlFor="trustProxy" className="text-sm font-medium text-foreground">
								Trust Proxy Headers
							</label>
							<p className="text-xs text-muted-foreground max-w-md">
								Enable when running behind a reverse proxy (Nginx, Traefik, Caddy). Trusts{" "}
								<code className="px-1 py-0.5 bg-card/50 rounded font-mono text-[10px]">
									X-Forwarded-For
								</code>{" "}
								and{" "}
								<code className="px-1 py-0.5 bg-card/50 rounded font-mono text-[10px]">
									X-Forwarded-Proto
								</code>{" "}
								headers for accurate client IP detection and rate limiting.
							</p>
						</div>
						<Switch
							id="trustProxy"
							checked={trustProxy}
							onCheckedChange={(checked) => {
								setTrustProxy(checked);
								// Auto-update secureCookies when trustProxy changes (if secureCookies is auto)
								if (secureCookies === null) {
									checkForChanges(apiPort, webPort, listenAddress, externalUrl, checked, null);
								} else {
									checkForChanges(apiPort, webPort, listenAddress, externalUrl, checked);
								}
							}}
						/>
					</div>

					{/* Secure Cookies Toggle */}
					<div className="flex items-start justify-between gap-6 max-w-2xl">
						<div className="space-y-1">
							<label htmlFor="secureCookies" className="text-sm font-medium text-foreground">
								<Lock className="inline h-3.5 w-3.5 mr-1.5 -mt-0.5 opacity-70" />
								Secure Cookies (HTTPS Only)
							</label>
							<p className="text-xs text-muted-foreground max-w-md">
								When enabled, session cookies are only sent over HTTPS connections.
								{secureCookies === null && (
									<span className="block mt-1" style={{ color: themeGradient.from }}>
										Auto-detecting from Trust Proxy setting ({trustProxy ? "enabled" : "disabled"})
									</span>
								)}
							</p>
						</div>
						<div className="flex items-center gap-3">
							{secureCookies !== null && (
								<button
									type="button"
									className="text-xs text-muted-foreground hover:text-foreground transition-colors"
									onClick={() => {
										setSecureCookies(null);
										checkForChanges(apiPort, webPort, listenAddress, externalUrl, undefined, null);
									}}
								>
									Reset to auto
								</button>
							)}
							<Switch
								id="secureCookies"
								checked={secureCookies ?? trustProxy}
								onCheckedChange={(checked) => {
									setSecureCookies(checked);
									checkForChanges(apiPort, webPort, listenAddress, externalUrl, undefined, checked);
								}}
							/>
						</div>
					</div>

					{/* Current Status */}
					<div className="grid gap-3 sm:grid-cols-2 max-w-2xl">
						<div className="flex items-center gap-2 text-xs text-muted-foreground">
							<Info className="h-3 w-3 shrink-0" />
							<span>
								Trust Proxy running:{" "}
								<code className="px-1.5 py-0.5 bg-card/50 rounded font-mono text-foreground">
									{settings?.data?.effectiveTrustProxy ? "enabled" : "disabled"}
								</code>
							</span>
						</div>
						<div className="flex items-center gap-2 text-xs text-muted-foreground">
							<Info className="h-3 w-3 shrink-0" />
							<span>
								Secure Cookies running:{" "}
								<code className="px-1.5 py-0.5 bg-card/50 rounded font-mono text-foreground">
									{settings?.data?.effectiveSecureCookies ? "enabled" : "disabled"}
								</code>
							</span>
						</div>
					</div>

					{/* Info Card */}
					<GlassmorphicCard padding="md">
						<div className="flex gap-3">
							<div
								className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
									border: `1px solid ${themeGradient.from}30`,
								}}
							>
								<Shield className="h-5 w-5" style={{ color: themeGradient.from }} />
							</div>
							<div className="space-y-2 text-sm">
								<p className="font-semibold text-foreground">When to enable Trust Proxy</p>
								<ul className="text-muted-foreground space-y-1 list-disc list-inside">
									<li>Running behind Nginx, Traefik, Caddy, or any reverse proxy</li>
									<li>Ensures accurate client IP in logs, sessions, and rate limiting</li>
									<li>Auto-enables secure cookies (HTTPS) for better session security</li>
									<li>
										<strong className="text-foreground">Do not enable</strong> if accessed directly
										without a proxy
									</li>
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
						boxShadow: hasChanges ? `0 4px 12px -4px ${themeGradient.glow}` : undefined,
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
