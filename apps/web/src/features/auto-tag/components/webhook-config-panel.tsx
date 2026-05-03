"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, Copy, RotateCw, Webhook } from "lucide-react";
import { useState } from "react";
import { GlassmorphicCard } from "../../../components/layout";
import { Button } from "../../../components/ui/button";
import { useIncognitoMode } from "../../../contexts/IncognitoContext";
import {
	fetchWebhookConfig,
	fetchWebhookInstallStatus,
	installWebhookOnInstances,
	regenerateWebhookSecret,
	type WebhookConfig,
	type WebhookInstallResponse,
} from "../../../lib/api-client/auto-tag-webhook";
import { autoTagKeys } from "../../../lib/query-keys";

export const WebhookConfigPanel = () => {
	const [copied, setCopied] = useState<"url" | "secret" | null>(null);
	const [incognitoMode] = useIncognitoMode();
	const queryClient = useQueryClient();

	const { data, isLoading } = useQuery({
		queryKey: autoTagKeys.webhookConfig,
		queryFn: fetchWebhookConfig,
	});

	const regenerate = useMutation({
		mutationFn: regenerateWebhookSecret,
		onSuccess: (next: WebhookConfig) => {
			queryClient.setQueryData<WebhookConfig>(autoTagKeys.webhookConfig, next);
		},
	});

	const handleRegenerate = async () => {
		if (
			!confirm(
				"Rotating the secret invalidates any existing Sonarr/Radarr Connect webhook using the old value. You'll need to update those settings. Continue?",
			)
		) {
			return;
		}
		await regenerate.mutateAsync();
	};

	const copy = async (value: string, kind: "url" | "secret") => {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(kind);
			setTimeout(() => setCopied(null), 1200);
		} catch {
			/* ignore */
		}
	};

	const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
	const urlTemplate = `${baseUrl}/api/auto-tag/webhook/<instance-id>`;

	return (
		<GlassmorphicCard>
			<div className="p-4 space-y-3">
				<div className="flex items-start gap-2">
					<Webhook className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
					<div className="flex-1 space-y-0.5">
						<h3 className="text-sm font-semibold">Real-time webhook (optional)</h3>
						<p className="text-xs text-muted-foreground">
							Wire Sonarr/Radarr Connect to fire this endpoint on import — auto-tagger evaluates
							rules against the new item within seconds instead of waiting for the 1h scheduled
							tick.
						</p>
					</div>
				</div>

				<div className="space-y-2">
					<div className="space-y-1">
						<label htmlFor="webhook-url" className="text-xs font-medium text-muted-foreground">
							Webhook URL (replace &lt;instance-id&gt; with each instance&rsquo;s ID from Settings)
						</label>
						<div className="flex gap-1">
							<input
								id="webhook-url"
								readOnly
								value={urlTemplate}
								className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-mono"
							/>
							<button
								type="button"
								onClick={() => copy(urlTemplate, "url")}
								className="px-2 rounded-md border border-input hover:bg-muted/30 text-xs"
								title="Copy URL"
							>
								{copied === "url" ? "✓" : <Copy className="h-3 w-3" />}
							</button>
						</div>
					</div>

					<div className="space-y-1">
						<label htmlFor="webhook-secret" className="text-xs font-medium text-muted-foreground">
							Authorization header (set as Authorization: Bearer &lt;secret&gt; in Connect)
						</label>
						<div className="flex gap-1">
							<input
								id="webhook-secret"
								readOnly
								value={
									isLoading
										? "Loading…"
										: incognitoMode && data?.secret
											? "•".repeat(43) // mask in incognito mode (43 = base64url length of 32 bytes)
											: data?.secret
												? data.secret
												: data?.configured
													? "(secret hidden — only shown once at generation; rotate to view a new one)"
													: ""
								}
								className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-mono"
							/>
							<button
								type="button"
								onClick={() => data?.secret && copy(data.secret, "secret")}
								disabled={!data?.secret || incognitoMode}
								className="px-2 rounded-md border border-input hover:bg-muted/30 text-xs disabled:opacity-50"
								title={
									incognitoMode
										? "Disable hide-sensitive-data to copy"
										: data?.secret
											? "Copy secret"
											: "Rotate to view a new secret"
								}
							>
								{copied === "secret" ? "✓" : <Copy className="h-3 w-3" />}
							</button>
						</div>
					</div>
				</div>

				<div className="flex justify-between items-center pt-1">
					<p className="text-xs text-muted-foreground">
						Sonarr/Radarr → Settings → Connect → Webhook → URL + Method POST + this Authorization
						header.
					</p>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={handleRegenerate}
						disabled={regenerate.isPending}
						className="text-xs"
					>
						<RotateCw className={`h-3 w-3 mr-1.5 ${regenerate.isPending ? "animate-spin" : ""}`} />
						Rotate secret
					</Button>
				</div>

				<AutoInstallSection plaintextSecret={data?.secret ?? null} />
			</div>
		</GlassmorphicCard>
	);
};

// ─── Auto-install sub-panel ──────────────────────────────────────────
//
// Discovers the user's enabled Sonarr/Radarr instances and installs the
// arr-dashboard Connect webhook in one click. The plaintext secret only
// exists in the browser session after a recent generation/rotation, so
// the install button is gated on that.

const AutoInstallSection = ({ plaintextSecret }: { plaintextSecret: string | null }) => {
	const queryClient = useQueryClient();
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [events, setEvents] = useState({ onDownload: true, onUpgrade: true, onGrab: false });
	const [lastResults, setLastResults] = useState<WebhookInstallResponse["results"] | null>(null);

	const statusQuery = useQuery({
		queryKey: autoTagKeys.webhookInstallStatus,
		queryFn: fetchWebhookInstallStatus,
	});

	const install = useMutation({
		mutationFn: () =>
			installWebhookOnInstances({
				secret: plaintextSecret as string,
				instanceIds: Array.from(selected),
				events,
			}),
		onSuccess: (response) => {
			setLastResults(response.results);
			queryClient.invalidateQueries({ queryKey: autoTagKeys.webhookInstallStatus });
		},
	});

	const instances = statusQuery.data?.instances ?? [];
	const hasSecret = Boolean(plaintextSecret);
	const canInstall = hasSecret && selected.size > 0 && !install.isPending;

	const toggleInstance = (id: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const selectAll = () => setSelected(new Set(instances.map((i) => i.instanceId)));
	const clearAll = () => setSelected(new Set());

	if (statusQuery.isLoading) {
		return (
			<div className="border-t border-border/40 pt-3">
				<p className="text-xs text-muted-foreground">Discovering *arr instances…</p>
			</div>
		);
	}

	if (instances.length === 0) {
		return (
			<div className="border-t border-border/40 pt-3 space-y-1">
				<h4 className="text-sm font-semibold flex items-center gap-2">
					<Webhook className="h-3.5 w-3.5" />
					Auto-install
				</h4>
				<p className="text-xs text-muted-foreground">
					No enabled Sonarr or Radarr instances configured. Add one in Settings → Services to enable
					webhook auto-install.
				</p>
			</div>
		);
	}

	return (
		<div className="border-t border-border/40 pt-3 space-y-3">
			<div className="flex items-start justify-between gap-2">
				<div>
					<h4 className="text-sm font-semibold flex items-center gap-2">
						<Webhook className="h-3.5 w-3.5" />
						Auto-install
					</h4>
					<p className="text-xs text-muted-foreground mt-0.5">
						Push the webhook config above to your Sonarr/Radarr instances in one click — no manual
						copy/paste in each *arr's Connect settings.
					</p>
				</div>
				<div className="flex gap-1 shrink-0">
					<button
						type="button"
						onClick={selectAll}
						className="text-xs text-muted-foreground hover:text-foreground transition"
					>
						Select all
					</button>
					<span className="text-xs text-muted-foreground">·</span>
					<button
						type="button"
						onClick={clearAll}
						className="text-xs text-muted-foreground hover:text-foreground transition"
					>
						None
					</button>
				</div>
			</div>

			<ul className="space-y-1">
				{instances.map((inst) => {
					const result = lastResults?.find((r) => r.instanceId === inst.instanceId);
					return (
						<li
							key={inst.instanceId}
							className="flex items-center justify-between gap-3 rounded-md border border-border/40 bg-card/20 px-3 py-2 text-xs"
						>
							<label className="flex items-center gap-2 flex-1 cursor-pointer">
								<input
									type="checkbox"
									checked={selected.has(inst.instanceId)}
									onChange={() => toggleInstance(inst.instanceId)}
									className="h-3.5 w-3.5"
								/>
								<span className="font-medium">{inst.label}</span>
								<span className="text-muted-foreground">({inst.service.toLowerCase()})</span>
							</label>
							<span className="text-xs">
								{result ? (
									result.status === "failed" ? (
										<span className="text-rose-400" title={result.error ?? "Failed"}>
											<AlertCircle className="h-3 w-3 inline mr-1" />
											{result.error?.slice(0, 60) ?? "Failed"}
										</span>
									) : (
										<span className="text-emerald-400">
											<Check className="h-3 w-3 inline mr-1" />
											{result.status === "updated" ? "Updated" : "Installed"}
										</span>
									)
								) : inst.error ? (
									<span className="text-amber-400" title={inst.error}>
										Probe failed
									</span>
								) : inst.installed ? (
									<span className="text-emerald-400/70">
										<Check className="h-3 w-3 inline mr-1" />
										Installed
									</span>
								) : (
									<span className="text-muted-foreground">Not installed</span>
								)}
							</span>
						</li>
					);
				})}
			</ul>

			<div className="flex flex-wrap items-center gap-3 text-xs">
				<span className="text-muted-foreground">Events:</span>
				{(["onDownload", "onUpgrade", "onGrab"] as const).map((ev) => (
					<label key={ev} className="flex items-center gap-1.5 cursor-pointer">
						<input
							type="checkbox"
							checked={events[ev]}
							onChange={(e) => setEvents((prev) => ({ ...prev, [ev]: e.target.checked }))}
							className="h-3 w-3"
						/>
						<span>
							{ev === "onDownload" ? "On Import" : ev === "onUpgrade" ? "On Upgrade" : "On Grab"}
						</span>
					</label>
				))}
			</div>

			{!hasSecret && (
				<div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
					<AlertCircle className="h-3.5 w-3.5 shrink-0" />
					<span>
						Click <strong>Rotate secret</strong> above to display the secret — needed for one-click
						install. (Existing manual webhooks will need to be reconfigured if you rotate.)
					</span>
				</div>
			)}

			{install.isError && (
				<div className="flex items-center gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
					<AlertCircle className="h-3.5 w-3.5 shrink-0" />
					<span>{(install.error as Error).message}</span>
				</div>
			)}

			<Button
				type="button"
				size="sm"
				onClick={() => install.mutate()}
				disabled={!canInstall}
				className="text-xs"
			>
				{install.isPending
					? "Installing…"
					: `Install / Update on ${selected.size} instance${selected.size === 1 ? "" : "s"}`}
			</Button>
		</div>
	);
};
