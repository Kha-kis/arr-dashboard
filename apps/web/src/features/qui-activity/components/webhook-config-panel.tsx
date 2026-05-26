"use client";

import { AlertCircle, Check, Copy, Power, RotateCw, Webhook } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { GlassmorphicCard } from "../../../components/layout";
import { Button } from "../../../components/ui/button";
import { useIncognitoMode } from "../../../contexts/IncognitoContext";
import {
	useQuiEventLog,
	useQuiWebhookConfig,
	useRegisterQuiWebhook,
	useRotateQuiWebhookSecret,
} from "../../../hooks/api/useQui";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { getErrorMessage } from "../../../lib/error-utils";
import { getLinuxInstanceName } from "../../../lib/incognito";

const SECRET_MASK = "•".repeat(43);

/**
 * qui webhook configuration panel (Phase 5.1).
 *
 * Surfaces:
 *   1. URL the operator pastes into qui's NotificationTarget.
 *   2. Secret rotation (plaintext shown once, post-rotate, in-memory only).
 *   3. Auto-registration of arr-dashboard's target inside qui via API.
 *   4. Recent-events strip pulled from QuiEventLog (proof the wire works).
 *
 * The "secret returned only at rotation time" model mirrors the auto-tag
 * webhook panel — we never persist plaintext, so re-displaying after a
 * page reload is impossible by design.
 */
export const QuiWebhookConfigPanel = () => {
	const [copied, setCopied] = useState<"url" | "secret" | "full" | null>(null);
	const [isIncognito] = useIncognitoMode();

	const config = useQuiWebhookConfig();
	const rotate = useRotateQuiWebhookSecret();
	const services = useServicesQuery();
	const eventLog = useQuiEventLog({ limit: 5 });

	const plaintextSecret = rotate.data?.secret ?? null;
	const recentEvents = eventLog.data?.pages.flatMap((p) => p.entries) ?? [];
	const quiInstances = (services.data ?? []).filter((s) => s.service === "qui" && s.enabled);

	const handleRotate = async () => {
		const ok = window.confirm(
			"Rotating the secret invalidates the URL you previously copied into qui's NotificationTarget. You'll need to re-register or paste the new URL. Continue?",
		);
		if (!ok) return;
		try {
			await rotate.mutateAsync();
		} catch (err) {
			// A failed rotation looks identical to a successful one from
			// the UI: spinner stops, but the operator has no way to know
			// the request didn't land. Surface the error so they can
			// distinguish "secret was rotated" from "rotation failed —
			// previous secret still valid" — the security model depends
			// on knowing which state you're in.
			toast.error("Couldn't rotate the webhook secret. Previous secret is still valid.", {
				description: getErrorMessage(err),
			});
		}
	};

	const copy = async (value: string, kind: "url" | "secret" | "full") => {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(kind);
			setTimeout(() => setCopied(null), 1200);
		} catch (err) {
			// Clipboard failure is operator-actionable (insecure context, denied
			// permission, focus issue) and silent failure leaves them clicking
			// repeatedly with no feedback. Especially important when the secret
			// field is masked in incognito mode — there's no hand-copy fallback
			// then. Surface a toast and the error so they can recover.
			toast.error("Couldn't copy to clipboard — select the value manually.", {
				description: getErrorMessage(err),
			});
		}
	};

	const baseUrl = config.data?.webhookUrl ?? "";
	const fullUrl = plaintextSecret ? `${baseUrl}?secret=${plaintextSecret}` : "";

	return (
		<GlassmorphicCard>
			<div className="p-4 space-y-3">
				<div className="flex items-start gap-2">
					<Webhook className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
					<div className="flex-1 space-y-0.5">
						<h3 className="text-sm font-semibold">qui webhook</h3>
						<p className="text-xs text-muted-foreground">
							Register arr-dashboard as a NotificationTarget in qui so torrent state changes push
							here in real time instead of waiting for the 10-minute scheduled sync. Events flow
							through SSE to live-invalidate the dashboard.
						</p>
					</div>
				</div>

				<div className="space-y-2">
					<div className="space-y-1">
						<label htmlFor="qui-webhook-url" className="text-xs font-medium text-muted-foreground">
							Webhook URL (paste into qui → Settings → Notifications → Targets)
						</label>
						<div className="flex gap-1">
							<input
								id="qui-webhook-url"
								readOnly
								value={config.isLoading ? "Loading…" : baseUrl}
								className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-mono"
							/>
							<button
								type="button"
								onClick={() => copy(baseUrl, "url")}
								disabled={!baseUrl}
								className="px-2 rounded-md border border-input hover:bg-muted/30 text-xs disabled:opacity-50"
								title="Copy URL"
							>
								{copied === "url" ? "✓" : <Copy className="h-3 w-3" />}
							</button>
						</div>
					</div>

					<div className="space-y-1">
						<label
							htmlFor="qui-webhook-secret"
							className="text-xs font-medium text-muted-foreground"
						>
							Query-param secret (append as <code>?secret=…</code> on the URL above)
						</label>
						<div className="flex gap-1">
							<input
								id="qui-webhook-secret"
								readOnly
								value={
									config.isLoading
										? "Loading…"
										: isIncognito && plaintextSecret
											? SECRET_MASK
											: plaintextSecret
												? plaintextSecret
												: config.data?.hasSecret
													? "(hidden — only shown once at rotation; rotate to view a new one)"
													: ""
								}
								className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-mono"
							/>
							<button
								type="button"
								onClick={() => plaintextSecret && copy(plaintextSecret, "secret")}
								disabled={!plaintextSecret || isIncognito}
								className="px-2 rounded-md border border-input hover:bg-muted/30 text-xs disabled:opacity-50"
								title={
									isIncognito
										? "Disable hide-sensitive-data to copy"
										: plaintextSecret
											? "Copy secret"
											: "Rotate to view a new secret"
								}
							>
								{copied === "secret" ? "✓" : <Copy className="h-3 w-3" />}
							</button>
						</div>
					</div>

					{plaintextSecret ? (
						<div className="space-y-1">
							<label
								htmlFor="qui-webhook-full-url"
								className="text-xs font-medium text-muted-foreground"
							>
								Full URL (one-shot copy for manual NotificationTarget entry)
							</label>
							<div className="flex gap-1">
								<input
									id="qui-webhook-full-url"
									readOnly
									value={isIncognito ? `${baseUrl}?secret=${SECRET_MASK}` : fullUrl}
									className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-mono"
								/>
								<button
									type="button"
									onClick={() => fullUrl && copy(fullUrl, "full")}
									disabled={!fullUrl || isIncognito}
									className="px-2 rounded-md border border-input hover:bg-muted/30 text-xs disabled:opacity-50"
									title="Copy URL + secret"
								>
									{copied === "full" ? "✓" : <Copy className="h-3 w-3" />}
								</button>
							</div>
						</div>
					) : null}
				</div>

				<div className="flex justify-between items-center pt-1">
					<p className="text-xs text-muted-foreground">
						qui → Settings → Notifications → Targets → URL + Method POST. arr-dashboard
						authenticates the inbound webhook via the <code>?secret=</code> param (qui's
						<code> ApiKeyQuery </code>scheme).
					</p>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={handleRotate}
						disabled={rotate.isPending}
						className="text-xs"
					>
						<RotateCw className={`h-3 w-3 mr-1.5 ${rotate.isPending ? "animate-spin" : ""}`} />
						Rotate secret
					</Button>
				</div>

				<AutoRegisterSection
					quiInstances={quiInstances}
					plaintextSecret={plaintextSecret}
					hasSecret={Boolean(config.data?.hasSecret)}
				/>

				<RecentEventsStrip
					recentEvents={recentEvents}
					isIncognito={isIncognito}
					isError={eventLog.isError}
				/>
			</div>
		</GlassmorphicCard>
	);
};

// ─── Auto-register sub-panel ─────────────────────────────────────────

interface AutoRegisterSectionProps {
	quiInstances: ReadonlyArray<{ id: string; label: string }>;
	plaintextSecret: string | null;
	hasSecret: boolean;
}

const AutoRegisterSection = ({
	quiInstances,
	plaintextSecret,
	hasSecret,
}: AutoRegisterSectionProps) => {
	const register = useRegisterQuiWebhook();
	const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
	const [resultByInstance, setResultByInstance] = useState<
		Record<string, { ok: true; targetId?: number } | { ok: false; error: string }>
	>({});

	const canRegister = Boolean(plaintextSecret && selectedInstanceId && !register.isPending);

	if (quiInstances.length === 0) {
		return (
			<div className="border-t border-border/40 pt-3 space-y-1">
				<h4 className="text-sm font-semibold flex items-center gap-2">
					<Webhook className="h-3.5 w-3.5" />
					Auto-register in qui
				</h4>
				<p className="text-xs text-muted-foreground">
					No enabled qui instances configured. Add one in Settings → Services to enable one-click
					target registration.
				</p>
			</div>
		);
	}

	const handleRegister = async () => {
		if (!selectedInstanceId || !plaintextSecret) return;
		try {
			const res = await register.mutateAsync({
				quiInstanceId: selectedInstanceId,
				secret: plaintextSecret,
			});
			setResultByInstance((prev) => ({
				...prev,
				[selectedInstanceId]: { ok: true, targetId: res.quiTargetId },
			}));
		} catch (err) {
			setResultByInstance((prev) => ({
				...prev,
				[selectedInstanceId]: {
					ok: false,
					error: getErrorMessage(err, "Registration failed"),
				},
			}));
		}
	};

	return (
		<div className="border-t border-border/40 pt-3 space-y-3">
			<div>
				<h4 className="text-sm font-semibold flex items-center gap-2">
					<Webhook className="h-3.5 w-3.5" />
					Auto-register in qui
				</h4>
				<p className="text-xs text-muted-foreground mt-0.5">
					Push the URL + secret to a qui instance in one click — no manual paste in qui's Settings
					UI. Available immediately after rotation; the plaintext secret is held in memory only.
				</p>
			</div>

			{!hasSecret ? (
				<div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
					<AlertCircle className="h-3.5 w-3.5 shrink-0" />
					<span>
						Click <strong>Rotate secret</strong> above to generate the value. arr-dashboard doesn't
						store plaintext, so registration needs a fresh rotation.
					</span>
				</div>
			) : !plaintextSecret ? (
				<div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
					<AlertCircle className="h-3.5 w-3.5 shrink-0" />
					<span>
						A secret exists but isn't visible right now. Click <strong>Rotate secret</strong> to
						display a new one (the old URL stops working when you rotate).
					</span>
				</div>
			) : null}

			<div className="space-y-2">
				{quiInstances.map((inst) => {
					const result = resultByInstance[inst.id];
					const selected = selectedInstanceId === inst.id;
					return (
						<label
							key={inst.id}
							className="flex items-center justify-between gap-3 rounded-md border border-border/40 bg-card/20 px-3 py-2 text-xs cursor-pointer"
						>
							<div className="flex items-center gap-2 flex-1">
								<input
									type="radio"
									name="qui-instance"
									checked={selected}
									onChange={() => setSelectedInstanceId(inst.id)}
									className="h-3.5 w-3.5"
								/>
								<span className="font-medium">{inst.label}</span>
								<span className="text-muted-foreground">(qui)</span>
							</div>
							<span className="text-xs">
								{result ? (
									result.ok ? (
										<span className="text-emerald-400">
											<Check className="h-3 w-3 inline mr-1" />
											{/* qui returns the new target's numeric id; surface it
											 * raw so an operator can correlate this row with qui's
											 * own Notifications → Targets list. */}
											Registered{result.targetId !== undefined ? ` · #${result.targetId}` : ""}
										</span>
									) : (
										// Render the full error rather than a 60-char head — the
										// last segment of qui's error message (after the path) is
										// usually the actionable bit (e.g., "503 Service Unavailable
										// - qBittorrent connection refused"). Truncation hides the
										// useful tail and the hover-only `title` doesn't work on touch.
										<span className="text-rose-400 break-words text-left">
											<AlertCircle className="h-3 w-3 inline mr-1" />
											{result.error}
										</span>
									)
								) : null}
							</span>
						</label>
					);
				})}
			</div>

			<Button
				type="button"
				size="sm"
				onClick={handleRegister}
				disabled={!canRegister}
				className="text-xs"
			>
				<Power className="h-3 w-3 mr-1.5" />
				{register.isPending ? "Registering…" : "Register selected instance"}
			</Button>
		</div>
	);
};

// ─── Recent events strip ─────────────────────────────────────────────

interface RecentEventsStripProps {
	recentEvents: Array<{
		id: string;
		eventType: string;
		torrentHash: string | null;
		serviceInstanceId: string | null;
		serviceInstanceLabel?: string | null;
		receivedAt: string;
	}>;
	isIncognito: boolean;
	/** True when the underlying `/qui/events` fetch failed. Distinguishes
	 * "wire genuinely empty" from "we couldn't load events" — without
	 * this flag the empty state lies, claiming the wire works when it
	 * may have errored. */
	isError: boolean;
}

const RecentEventsStrip = ({ recentEvents, isIncognito, isError }: RecentEventsStripProps) => {
	if (isError) {
		// Distinguish "fetch errored" from "fetch succeeded + 0 events".
		// The default empty-state message claims the wire works; if it's
		// shown while the fetch is broken, it's actively misleading.
		return (
			<div className="border-t border-border/40 pt-3">
				<h4 className="text-sm font-semibold mb-1">Recent events</h4>
				<p className="text-xs text-amber-300/80">
					Couldn't load recent events — the event-log endpoint returned an error. Webhook delivery
					may still be working; this is a display-side problem. Refresh the page or check the server
					logs.
				</p>
			</div>
		);
	}
	if (recentEvents.length === 0) {
		return (
			<div className="border-t border-border/40 pt-3">
				<h4 className="text-sm font-semibold mb-1">Recent events</h4>
				<p className="text-xs text-muted-foreground">
					No webhook events received yet. Once registered, events will appear here within seconds —
					proving the wire works end-to-end.
				</p>
			</div>
		);
	}

	return (
		<div className="border-t border-border/40 pt-3 space-y-2">
			<h4 className="text-sm font-semibold">Recent events</h4>
			<ul className="space-y-1">
				{recentEvents.map((ev) => {
					// Prefer the hydrated label; fall back through id then "—".
					const instanceRaw = ev.serviceInstanceLabel ?? ev.serviceInstanceId ?? "—";
					const instance = isIncognito ? getLinuxInstanceName(instanceRaw) : instanceRaw;
					return (
						<li
							key={ev.id}
							className="flex items-center justify-between gap-3 rounded-md border border-border/40 bg-card/20 px-3 py-1.5 text-xs"
						>
							<span className="font-mono text-muted-foreground">{ev.eventType}</span>
							<span className="font-mono text-muted-foreground/70 truncate flex-1 mx-2">
								{ev.torrentHash ? shortenHash(ev.torrentHash) : instance}
							</span>
							<time className="text-muted-foreground/70" dateTime={ev.receivedAt}>
								{relative(ev.receivedAt)}
							</time>
						</li>
					);
				})}
			</ul>
		</div>
	);
};

function shortenHash(hash: string): string {
	if (hash.length <= 16) return hash;
	return `${hash.slice(0, 8)}…${hash.slice(-8)}`;
}

function relative(iso: string): string {
	const now = Date.now();
	const then = new Date(iso).getTime();
	const diff = Math.max(0, Math.round((now - then) / 1000));
	if (diff < 60) return `${diff}s ago`;
	if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
	return `${Math.round(diff / 86400)}d ago`;
}
