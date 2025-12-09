"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Settings, RefreshCw, AlertTriangle, Info, ExternalLink } from "lucide-react";
import { apiRequest } from "../../../lib/api-client/base";

interface SystemSettings {
	urlBase: string;
	apiPort: number;
	webPort: number;
	appName: string;
	effectiveBasePath: string;
	effectiveApiPort: number;
	effectiveWebPort: number;
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
	urlBase?: string;
	apiPort?: number;
	webPort?: number;
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
	const [urlBase, setUrlBase] = useState("");
	const [apiPort, setApiPort] = useState(3001);
	const [webPort, setWebPort] = useState(3000);
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
			setUrlBase(settings.data.urlBase);
			setApiPort(settings.data.apiPort);
			setWebPort(settings.data.webPort);
		}
	}, [settings?.data]);

	// Check if any value has changed
	const checkForChanges = (newUrlBase: string, newApiPort: number, newWebPort: number) => {
		const originalUrlBase = settings?.data?.urlBase ?? "";
		const originalApiPort = settings?.data?.apiPort ?? 3001;
		const originalWebPort = settings?.data?.webPort ?? 3000;

		setHasChanges(
			newUrlBase !== originalUrlBase ||
			newApiPort !== originalApiPort ||
			newWebPort !== originalWebPort
		);
	};

	const handleUrlBaseChange = (value: string) => {
		setUrlBase(value);
		checkForChanges(value, apiPort, webPort);
	};

	const handleApiPortChange = (value: string) => {
		const port = Number.parseInt(value, 10) || 0;
		setApiPort(port);
		checkForChanges(urlBase, port, webPort);
	};

	const handleWebPortChange = (value: string) => {
		const port = Number.parseInt(value, 10) || 0;
		setWebPort(port);
		checkForChanges(urlBase, apiPort, port);
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
		updateMutation.mutate({ urlBase, apiPort, webPort });
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
							Changes to URL Base or port settings require a container restart to take effect.
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
						Configure the ports for the web UI and API server
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
								Currently: <code className="px-1 py-0.5 bg-bg-subtle rounded font-mono">{settings?.data?.effectiveWebPort}</code>
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
								Currently: <code className="px-1 py-0.5 bg-bg-subtle rounded font-mono">{settings?.data?.effectiveApiPort}</code>
							</span>
						</div>
					</div>
				</div>

				<p className="text-xs text-fg-muted">
					Note: When changing ports, make sure to update your Docker port mappings accordingly.
				</p>
			</div>

			{/* URL Base Section */}
			<div className="rounded-lg border border-border bg-bg-card p-6 space-y-4">
				<div>
					<h3 className="text-lg font-medium text-fg">URL Base</h3>
					<p className="text-sm text-fg-muted mt-1">
						Set a base path for reverse proxy deployments (e.g., /arr-dashboard)
					</p>
				</div>

				<div className="space-y-3">
					<div>
						<label htmlFor="urlBase" className="block text-sm font-medium text-fg mb-1">
							URL Base Path
						</label>
						<input
							id="urlBase"
							type="text"
							value={urlBase}
							onChange={(e) => handleUrlBaseChange(e.target.value)}
							placeholder="/arr-dashboard"
							className="w-full max-w-md rounded-lg border border-border bg-bg-subtle px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
						/>
						<p className="text-xs text-fg-muted mt-1">
							Leave empty for root path. Must start with / and not end with /.
						</p>
					</div>

					{/* Current effective path */}
					<div className="flex items-center gap-2 text-sm">
						<Info className="h-4 w-4 text-blue-500" />
						<span className="text-fg-muted">
							Currently active:{" "}
							<code className="px-1.5 py-0.5 bg-bg-subtle rounded text-fg font-mono">
								{settings?.data?.effectiveBasePath || "(root)"}
							</code>
						</span>
					</div>
				</div>

				{/* Example configuration */}
				<details className="mt-4">
					<summary className="text-sm font-medium text-fg-muted cursor-pointer hover:text-fg">
						Example Reverse Proxy Configuration
					</summary>
					<div className="mt-3 space-y-3 text-sm">
						<div className="rounded-lg bg-bg-subtle p-4">
							<p className="font-medium text-fg mb-2">Traefik (Docker label):</p>
							<pre className="text-xs text-fg-muted overflow-x-auto">
{`traefik.http.routers.arr-dashboard.rule=PathPrefix(\`/arr-dashboard\`)
traefik.http.middlewares.arr-strip.stripprefix.prefixes=/arr-dashboard
traefik.http.routers.arr-dashboard.middlewares=arr-strip`}
							</pre>
						</div>
						<div className="rounded-lg bg-bg-subtle p-4">
							<p className="font-medium text-fg mb-2">Nginx:</p>
							<pre className="text-xs text-fg-muted overflow-x-auto">
{`location /arr-dashboard/ {
    proxy_pass http://arr-dashboard:3000/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}`}
							</pre>
						</div>
						<p className="text-fg-muted flex items-center gap-1">
							<ExternalLink className="h-3 w-3" />
							<a
								href="https://github.com/Kha-kis/arr-dashboard#reverse-proxy"
								target="_blank"
								rel="noopener noreferrer"
								className="text-primary hover:underline"
							>
								View full documentation
							</a>
						</p>
					</div>
				</details>
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
