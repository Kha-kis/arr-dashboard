"use client";

/**
 * Statistics — Tracearr detail panels (charter C2b).
 *
 * Watch history, users (trust scores), and account-sharing violations from
 * Tracearr — the deep, cross-server dimensions SessionSnapshot can't provide.
 * Each is a paginated table over a single Tracearr hub instance.
 *
 * INCOGNITO: these panels render media titles, usernames, and server names —
 * all masked via the shared Linux-ISO helpers when incognito is on.
 */

import type {
	TracearrPaginationMeta,
	TracearrSessionHistory,
	TracearrUser,
	TracearrViolation,
} from "@arr/shared";
import { ChevronLeft, ChevronRight, ShieldAlert, TrendingUp, Users } from "lucide-react";
import { useState } from "react";
import { AsyncStateView, formatRelativeTime } from "../../../components/layout";
import {
	useTracearrHistory,
	useTracearrUsers,
	useTracearrViolations,
} from "../../../hooks/api/useTracearr";
import {
	getLinuxInstanceName,
	getLinuxIsoName,
	getLinuxUsername,
	useIncognitoMode,
} from "../../../lib/incognito";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";

const PAGE_SIZE = 25;

function PanelCard({
	title,
	subtitle,
	children,
}: {
	title: string;
	subtitle?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="rounded-xl border border-border/50 bg-card/30 p-4 backdrop-blur-sm">
			<div className="mb-3">
				<h3 className="text-sm font-medium text-foreground">{title}</h3>
				{subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
			</div>
			{children}
		</div>
	);
}

/** Prev/next pager. `meta` is the server's { total, page, pageSize }. */
function Pagination({
	meta,
	page,
	onChange,
	isFetching,
}: {
	meta?: TracearrPaginationMeta;
	page: number;
	onChange: (page: number) => void;
	isFetching: boolean;
}) {
	// Trust the server's page size, not our requested constant — if Tracearr
	// clamps to a smaller page, computing lastPage from PAGE_SIZE would disable
	// Next early and silently hide rows (a signal-accuracy violation).
	const size = meta?.pageSize || PAGE_SIZE;
	const total = meta?.total ?? 0;
	const lastPage = Math.max(1, Math.ceil(total / size));
	if (total <= size) return null;
	return (
		<div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
			<span>
				Page {page} of {lastPage} · {total} total
			</span>
			<div className="flex items-center gap-1">
				<button
					type="button"
					onClick={() => onChange(page - 1)}
					disabled={page <= 1 || isFetching}
					className="flex items-center gap-1 rounded-md border border-border/50 px-2 py-1 disabled:opacity-40"
					aria-label="Previous page"
				>
					<ChevronLeft className="h-3.5 w-3.5" />
				</button>
				<button
					type="button"
					onClick={() => onChange(page + 1)}
					disabled={page >= lastPage || isFetching}
					className="flex items-center gap-1 rounded-md border border-border/50 px-2 py-1 disabled:opacity-40"
					aria-label="Next page"
				>
					<ChevronRight className="h-3.5 w-3.5" />
				</button>
			</div>
		</div>
	);
}

function EmptyRow({ label }: { label: string }) {
	return <p className="text-xs text-muted-foreground">{label}</p>;
}

// ── Watch history ───────────────────────────────────────────────────

export function TracearrHistoryPanel() {
	const [incognito] = useIncognitoMode();
	const [page, setPage] = useState(1);
	const query = useTracearrHistory(page);
	const rows = query.data?.history.data ?? [];

	const mask = (s: TracearrSessionHistory) => {
		const rawTitle = s.mediaTitle || s.showTitle || "Untitled";
		const rawUser = s.username || s.user?.username || "Unknown user";
		const rawServer = s.serverName || "";
		return {
			title: incognito ? getLinuxIsoName(rawTitle) : rawTitle,
			user: incognito ? getLinuxUsername(rawUser) : rawUser,
			server: rawServer ? (incognito ? getLinuxInstanceName(rawServer) : rawServer) : "",
		};
	};

	return (
		<PanelCard title="Watch history" subtitle="Complete history across all Tracearr servers">
			<AsyncStateView
				isLoading={query.isLoading}
				isError={query.isError}
				error={query.error}
				onRetry={() => void query.refetch()}
				errorTitle="Couldn't load history"
				loadingFallback={<div className="h-40 animate-pulse rounded-lg bg-muted/10" />}
				emptyState={{ icon: TrendingUp, title: "No history", description: "" }}
			>
				{rows.length === 0 ? (
					<EmptyRow label="No watch history recorded yet." />
				) : (
					<ul className="space-y-2" data-testid="tracearr-history-rows">
						{rows.map((row) => {
							const m = mask(row);
							const when = row.stoppedAt || row.startedAt;
							const isTranscode = row.isTranscode || row.videoDecision === "transcode";
							return (
								<li
									key={row.id}
									className="flex items-center gap-3 rounded-lg border border-border/40 bg-card/40 p-2.5"
								>
									<div className="min-w-0 flex-1">
										<p className="truncate text-sm text-foreground">{m.title}</p>
										<p className="truncate text-xs text-muted-foreground">
											{m.user}
											{m.server ? ` · ${m.server}` : ""}
										</p>
									</div>
									{isTranscode && (
										<span className="shrink-0 text-xs text-muted-foreground">Transcode</span>
									)}
									{when && (
										<span className="shrink-0 text-xs text-muted-foreground">
											{formatRelativeTime(new Date(when).getTime())}
										</span>
									)}
								</li>
							);
						})}
					</ul>
				)}
				<Pagination
					meta={query.data?.history.meta}
					page={page}
					onChange={setPage}
					isFetching={query.isFetching}
				/>
			</AsyncStateView>
		</PanelCard>
	);
}

// ── Users + trust scores ────────────────────────────────────────────

function trustColor(score?: number): string {
	if (score === undefined) return SEMANTIC_COLORS.neutral.text;
	if (score >= 70) return SEMANTIC_COLORS.success.text;
	if (score >= 40) return SEMANTIC_COLORS.warning.text;
	return SEMANTIC_COLORS.error.text;
}

export function TracearrUsersPanel() {
	const [incognito] = useIncognitoMode();
	const [page, setPage] = useState(1);
	const query = useTracearrUsers(page);
	const rows = query.data?.users.data ?? [];

	const maskUser = (u: TracearrUser) => {
		const raw = u.displayName || u.username || "Unknown user";
		return incognito ? getLinuxUsername(raw) : raw;
	};

	return (
		<PanelCard title="Users" subtitle="Trust scores + violation counts">
			<AsyncStateView
				isLoading={query.isLoading}
				isError={query.isError}
				error={query.error}
				onRetry={() => void query.refetch()}
				errorTitle="Couldn't load users"
				loadingFallback={<div className="h-40 animate-pulse rounded-lg bg-muted/10" />}
				emptyState={{ icon: Users, title: "No users", description: "" }}
			>
				{rows.length === 0 ? (
					<EmptyRow label="No users tracked yet." />
				) : (
					<ul className="space-y-2" data-testid="tracearr-users-rows">
						{rows.map((user) => (
							<li
								key={user.id}
								className="flex items-center gap-3 rounded-lg border border-border/40 bg-card/40 p-2.5"
							>
								<div className="min-w-0 flex-1">
									<p className="truncate text-sm text-foreground">{maskUser(user)}</p>
									<p className="truncate text-xs text-muted-foreground">
										{user.role ?? "member"}
										{user.lastActivityAt
											? ` · active ${formatRelativeTime(new Date(user.lastActivityAt).getTime())}`
											: ""}
									</p>
								</div>
								{user.totalViolations !== undefined && user.totalViolations > 0 && (
									<span className="shrink-0 text-xs text-muted-foreground">
										{user.totalViolations} violation{user.totalViolations === 1 ? "" : "s"}
									</span>
								)}
								{user.trustScore !== undefined && (
									<span
										className="shrink-0 text-xs font-medium tabular-nums"
										style={{ color: trustColor(user.trustScore) }}
										title="Trust score"
									>
										{user.trustScore}
									</span>
								)}
							</li>
						))}
					</ul>
				)}
				<Pagination
					meta={query.data?.users.meta}
					page={page}
					onChange={setPage}
					isFetching={query.isFetching}
				/>
			</AsyncStateView>
		</PanelCard>
	);
}

// ── Violations (account-sharing) ────────────────────────────────────

const SEVERITY_COLOR: Record<string, string> = {
	low: SEMANTIC_COLORS.neutral.text,
	warning: SEMANTIC_COLORS.warning.text,
	high: SEMANTIC_COLORS.error.text,
};

export function TracearrViolationsPanel() {
	const [incognito] = useIncognitoMode();
	const [page, setPage] = useState(1);
	const query = useTracearrViolations(page);
	const rows = query.data?.violations.data ?? [];

	const maskUser = (v: TracearrViolation) => {
		const raw = v.user?.username || "Unknown user";
		return incognito ? getLinuxUsername(raw) : raw;
	};

	return (
		<PanelCard title="Account-sharing violations" subtitle="Flagged by Tracearr">
			<AsyncStateView
				isLoading={query.isLoading}
				isError={query.isError}
				error={query.error}
				onRetry={() => void query.refetch()}
				errorTitle="Couldn't load violations"
				loadingFallback={<div className="h-40 animate-pulse rounded-lg bg-muted/10" />}
				emptyState={{ icon: ShieldAlert, title: "No violations", description: "" }}
			>
				{rows.length === 0 ? (
					<EmptyRow label="No violations detected — nothing to review." />
				) : (
					<ul className="space-y-2" data-testid="tracearr-violations-rows">
						{rows.map((v) => (
							<li
								key={v.id}
								className="flex items-center gap-3 rounded-lg border border-border/40 bg-card/40 p-2.5"
							>
								<span
									className="shrink-0 text-xs font-medium capitalize"
									style={{ color: SEVERITY_COLOR[v.severity ?? "warning"] }}
								>
									{v.severity ?? "warning"}
								</span>
								<div className="min-w-0 flex-1">
									{/* rule.name is an operator-authored rule template (e.g. "Concurrent
									    locations"), not user PII — left unmasked deliberately, since
									    masking would garble legitimate generic names. The violating
									    user (below) IS masked. */}
									<p className="truncate text-sm text-foreground">
										{v.rule?.name ?? "Account sharing"}
									</p>
									<p className="truncate text-xs text-muted-foreground">
										{maskUser(v)}
										{v.createdAt ? ` · ${formatRelativeTime(new Date(v.createdAt).getTime())}` : ""}
									</p>
								</div>
								{v.acknowledged && (
									<span className="shrink-0 text-xs text-muted-foreground">Acknowledged</span>
								)}
							</li>
						))}
					</ul>
				)}
				<Pagination
					meta={query.data?.violations.meta}
					page={page}
					onChange={setPage}
					isFetching={query.isFetching}
				/>
			</AsyncStateView>
		</PanelCard>
	);
}
