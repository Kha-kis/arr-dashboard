"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, RotateCw, Webhook } from "lucide-react";
import { useState } from "react";
import { GlassmorphicCard } from "../../../components/layout";
import { Button } from "../../../components/ui/button";
import { useIncognitoMode } from "../../../contexts/IncognitoContext";
import {
	fetchWebhookConfig,
	regenerateWebhookSecret,
	type WebhookConfig,
} from "../../../lib/api-client/auto-tag-webhook";

const QUERY_KEY = ["auto-tag", "webhook-config"] as const;

export const WebhookConfigPanel = () => {
	const [copied, setCopied] = useState<"url" | "secret" | null>(null);
	const [incognitoMode] = useIncognitoMode();
	const queryClient = useQueryClient();

	const { data, isLoading } = useQuery({
		queryKey: QUERY_KEY,
		queryFn: fetchWebhookConfig,
	});

	const regenerate = useMutation({
		mutationFn: regenerateWebhookSecret,
		onSuccess: (next: WebhookConfig) => {
			queryClient.setQueryData<WebhookConfig>(QUERY_KEY, next);
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
							Webhook URL (replace &lt;instance-id&gt; with each instance's ID from Settings)
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
			</div>
		</GlassmorphicCard>
	);
};
