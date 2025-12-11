"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Settings, RefreshCw, AlertTriangle, Info } from "lucide-react";
import { apiRequest } from "../../../lib/api-client/base";

interface SystemSettings {
	apiPort: number;
	webPort: number;
	listenAddress: string;
	appName: string;
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

async function getSystemSettings(): Promise<SystemSettingsResponse> {
	return apiRequest<SystemSettingsResponse>("/api/system/settings");
}

async function updateSystemSettings(data: {
	apiPort?: number;
	webPort?: number;
	listenAddress?: string;
	appName?: string;
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

export function SystemTab() {
	const queryClient = useQueryClient();
	const [apiPort, setApiPort] = useState(3001);
	const [webPort, setWebPort] = useState(3000);
	const [listenAddress, setListenAddress] = useState("0.0.0.0");
	const [hasChanges, setHasChanges] = useState(false);

	const { data: settings, isLoading } = useQuery({
		queryKey: ["system-settings"],
		queryFn: getSystemSettings,
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

	// Sync local state with fetched data
	useEffect(() => {
		if (settings?.data) {
			setApiPort(settings.data.apiPort);
			setWebPort(settings.data.webPort);
			setListenAddress(settings.data.listenAddress || "0.0.0.0");
		}
	}, [settings?.data]);

	// Check if any value has changed
	const checkForChanges = (newApiPort: number, newWebPort: number, newListenAddress: string) => {
		const originalApiPort = settings?.data?.apiPort ?? 3001;
		const originalWebPort = settings?.data?.webPort ?? 3000;
		const originalListenAddress = settings?.data?.listenAddress ?? "0.0.0.0";

		setHasChanges(
			newApiPort !== originalApiPort ||
			newWebPort !== originalWebPort ||
			newListenAddress !== originalListenAddress
		);
	};

	const handleApiPortChange = (value: string) => {
		const port = Number.parseInt(value, 10) || 0;
		setApiPort(port);
		checkForChanges(port, webPort, listenAddress);
	};

	const handleWebPortChange = (value: string) => {
		const port = Number.parseInt(value, 10) || 0;
		setWebPort(port);
		checkForChanges(apiPort, port, listenAddress);
	};

	const handleListenAddressChange = (value: string) => {
		setListenAddress(value);
		checkForChanges(apiPort, webPort, value);
	};

	const handleSave = () => {
		// Validate ports before saving
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
		updateMutation.mutate({ apiPort, webPort, listenAddress });
	};

	const handleRestart = () => {
		if (confirm("Are you sure you want to restart the application? This will temporarily interrupt service.")) {
			restartMutation.mutate();
		}
	};

	if (isLoading) {
		return (
			<div className="animate-pulse space-y-4">
				<div className="h-8 bg-bg-subtle rounded w-1/3" />
				<div className="h-32 bg-bg-subtle rounded" />
			</div>
		);
	}

	const requiresRestart = settings?.data?.requiresRestart || hasChanges;

	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="flex items-center gap-3">
				<Settings className="h-6 w-6 text-fg-muted" />
				<div>
					<h2 className="text-xl font-semibold text-fg">System Settings</h2>
					<p className="text-sm text-fg-muted">
						Configure application-wide settings
					</p>
				</div>
			</div>

			{/* Restart Warning Banner */}
			{requiresRestart && (
				<div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
					<AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
					<div className="text-sm flex-1">
						<p className="font-medium text-amber-700 dark:text-amber-400">
							Restart Required
						</p>
						<p className="text-amber-600 dark:text-amber-500 mt-0.5">
							Changes to port or listen address settings require a container restart to take effect.
						</p>
					</div>
					{!hasChanges && (
						<button
							type="button"
							onClick={handleRestart}
							disabled={restartMutation.isPending}
							className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-amber-700 dark:text-amber-400 bg-amber-500/20 border border-amber-500/30 rounded-lg hover:bg-amber-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
						>
							<RefreshCw className={`h-4 w-4 ${restartMutation.isPending ? "animate-spin" : ""}`} />
							{restartMutation.isPending ? "Restarting..." : "Restart Now"}
						</button>
					)}
				</div>
			)}

			{/* Port Configuration Section */}
			<div className="rounded-lg border border-border bg-bg-card p-6 space-y-4">
				<div>
					<h3 className="text-lg font-medium text-fg">Port Configuration</h3>
					<p className="text-sm text-fg-muted mt-1">
						Internal container ports for the web UI and API server
					</p>
				</div>

				<div className="grid gap-4 sm:grid-cols-2 max-w-lg">
					<div>
						<label htmlFor="webPort" className="block text-sm font-medium text-fg mb-1">
							Web UI Port
						</label>
						<input
							id="webPort"
							type="number"
							min="1"
							max="65535"
							value={webPort}
							onChange={(e) => handleWebPortChange(e.target.value)}
							className="w-full rounded-lg border border-border bg-bg-subtle px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
						/>
						<div className="flex items-center gap-1 mt-1 text-xs text-fg-muted">
							<Info className="h-3 w-3" />
							<span>
								Running on: <code className="px-1 py-0.5 bg-bg-subtle rounded font-mono">{settings?.data?.effectiveWebPort}</code>
							</span>
						</div>
					</div>

					<div>
						<label htmlFor="apiPort" className="block text-sm font-medium text-fg mb-1">
							API Port
						</label>
						<input
							id="apiPort"
							type="number"
							min="1"
							max="65535"
							value={apiPort}
							onChange={(e) => handleApiPortChange(e.target.value)}
							className="w-full rounded-lg border border-border bg-bg-subtle px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
						/>
						<div className="flex items-center gap-1 mt-1 text-xs text-fg-muted">
							<Info className="h-3 w-3" />
							<span>
								Running on: <code className="px-1 py-0.5 bg-bg-subtle rounded font-mono">{settings?.data?.effectiveApiPort}</code>
							</span>
						</div>
					</div>
				</div>

				{/* How ports work info box */}
				<div className="rounded-lg bg-blue-500/10 border border-blue-500/20 p-4">
					<div className="flex gap-3">
						<Info className="h-5 w-5 text-blue-500 flex-shrink-0 mt-0.5" />
						<div className="space-y-2 text-sm">
							<p className="text-fg">
								<strong>How port configuration works:</strong>
							</p>
							<ul className="text-fg-muted space-y-1 list-disc list-inside">
								<li>Change ports here and <strong>restart the container</strong> to apply</li>
								<li>Environment variables (API_PORT, PORT) override these settings</li>
								<li>Priority: Environment variable → Database → Default</li>
							</ul>
							<details className="mt-2">
								<summary className="text-fg-muted cursor-pointer hover:text-fg font-medium">
									Docker port mapping info
								</summary>
								<div className="mt-2 text-fg-muted space-y-1">
									<p>These are <em>internal</em> container ports (default: 3000). To access on a different host port:</p>
									<pre className="text-xs bg-bg-subtle rounded p-2 overflow-x-auto mt-1">
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
							</details>
						</div>
					</div>
				</div>
			</div>

			{/* Listen Address Section */}
			<div className="rounded-lg border border-border bg-bg-card p-6 space-y-4">
				<div>
					<h3 className="text-lg font-medium text-fg">Listen Address</h3>
					<p className="text-sm text-fg-muted mt-1">
						Network interface binding address for the application
					</p>
				</div>

				<div className="space-y-3">
					<div>
						<label className="block text-sm font-medium text-fg mb-2">
							Quick Select
						</label>
						<div className="flex flex-wrap gap-2">
							{[
								{ value: "0.0.0.0", label: "0.0.0.0", desc: "All interfaces (Docker)" },
								{ value: "127.0.0.1", label: "127.0.0.1", desc: "Localhost only" },
								{ value: "::", label: "::", desc: "All IPv6" },
							].map((preset) => (
								<button
									key={preset.value}
									type="button"
									onClick={() => handleListenAddressChange(preset.value)}
									className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
										listenAddress === preset.value
											? "border-primary bg-primary/10 text-primary"
											: "border-border bg-bg-subtle text-fg-muted hover:border-fg-muted"
									}`}
								>
									<code className="font-mono">{preset.label}</code>
									<span className="ml-1.5 text-xs opacity-75">({preset.desc})</span>
								</button>
							))}
						</div>
					</div>

					<div className="max-w-xs">
						<label htmlFor="listenAddress" className="block text-sm font-medium text-fg mb-1">
							Custom IP Address
						</label>
						<input
							id="listenAddress"
							type="text"
							value={listenAddress}
							onChange={(e) => handleListenAddressChange(e.target.value)}
							placeholder="e.g., 192.168.1.100"
							className="w-full rounded-lg border border-border bg-bg-subtle px-3 py-2 text-sm text-fg font-mono placeholder:text-fg-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
						/>
						<div className="flex items-center gap-1 mt-1 text-xs text-fg-muted">
							<Info className="h-3 w-3" />
							<span>
								Running on: <code className="px-1 py-0.5 bg-bg-subtle rounded font-mono">{settings?.data?.effectiveListenAddress}</code>
							</span>
						</div>
					</div>
				</div>

				{/* Listen address info */}
				<div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-4">
					<div className="flex gap-3">
						<AlertTriangle className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
						<div className="space-y-2 text-sm">
							<p className="text-fg">
								<strong>Important for Docker users:</strong>
							</p>
							<ul className="text-fg-muted space-y-1 list-disc list-inside">
								<li><code className="text-xs px-1 py-0.5 bg-bg-subtle rounded">0.0.0.0</code> is <strong>required</strong> for Docker containers - allows access from outside the container</li>
								<li><code className="text-xs px-1 py-0.5 bg-bg-subtle rounded">127.0.0.1</code> restricts access to localhost only (local development or reverse proxy on same host)</li>
								<li>Changing this requires a <strong>container restart</strong></li>
							</ul>
						</div>
					</div>
				</div>
			</div>

			{/* Actions */}
			<div className="flex items-center gap-3">
				<button
					type="button"
					onClick={handleSave}
					disabled={!hasChanges || updateMutation.isPending}
					className="px-4 py-2 text-sm font-medium text-white bg-primary rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
				>
					{updateMutation.isPending ? "Saving..." : "Save Changes"}
				</button>

				{requiresRestart && hasChanges && (
					<p className="text-sm text-fg-muted">
						Save changes first, then restart to apply.
					</p>
				)}
			</div>
		</div>
	);
}
