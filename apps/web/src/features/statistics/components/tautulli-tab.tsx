"use client";

import { BarChart3, History, Users } from "lucide-react";
import { AsyncStateView } from "../../../components/layout";
import {
	useTautulliHistory,
	useTautulliPlaysByDate,
	useTautulliStats,
} from "../../../hooks/api/useTautulli";
import {
	getLinuxInstanceName,
	getLinuxIsoName,
	getLinuxUsername,
	useIncognitoMode,
} from "../../../lib/incognito";
import { SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { Sparkline } from "./chart-primitives";

const ACCENT = SERVICE_GRADIENTS.tautulli;

function sourceLabel(label: string, incognitoMode: boolean) {
	return incognitoMode ? getLinuxInstanceName(label) : label;
}

function titleLabel(title: string, incognitoMode: boolean) {
	return incognitoMode ? getLinuxIsoName(title) : title;
}

function userLabel(username: string, incognitoMode: boolean) {
	return incognitoMode ? getLinuxUsername(username) : username;
}

export function TautulliTab() {
	const [incognitoMode] = useIncognitoMode();
	const statsQuery = useTautulliStats();
	const playsQuery = useTautulliPlaysByDate();
	const historyQuery = useTautulliHistory();
	const stats = statsQuery.data;
	const plays = playsQuery.data;
	const history = historyQuery.data;

	return (
		<div className="flex flex-col gap-6" data-testid="tautulli-analytics">
			<AsyncStateView
				isLoading={statsQuery.isLoading}
				isError={statsQuery.isError}
				error={statsQuery.error}
				onRetry={() => void statsQuery.refetch()}
				errorTitle="Couldn't load Tautulli statistics"
				loadingFallback={<div className="h-24 animate-pulse rounded-xl bg-muted/10" />}
				emptyState={{ icon: BarChart3, title: "No Tautulli statistics", description: "" }}
			>
				{stats && (
					<div className="grid gap-4 lg:grid-cols-2">
						{stats.sources.map((source) => (
							<section
								key={source.instanceId}
								className="rounded-xl border border-border/50 bg-card/30 p-4"
							>
								<h2 className="font-medium">{sourceLabel(source.instanceLabel, incognitoMode)}</h2>
								{source.incompleteReason && (
									<p className="mt-1 text-xs text-warning">Some user statistics are incomplete.</p>
								)}
								<div className="mt-3 grid gap-3 sm:grid-cols-2">
									{source.homeStats.map((stat) => (
										<div key={stat.stat_id} className="rounded-lg border border-border/40 p-3">
											<h3 className="text-sm font-medium">{stat.stat_title}</h3>
											{stat.rows.length > 0 ? (
												<ul className="mt-2 space-y-1 text-sm text-muted-foreground">
													{stat.rows.slice(0, source.rankingLimit).map((row, index) => (
														<li key={`${stat.stat_id}-${row.rating_key ?? row.user_id ?? index}`}>
															{row.title
																? titleLabel(row.title, incognitoMode)
																: row.friendly_name || row.user
																	? userLabel(row.friendly_name ?? row.user ?? "", incognitoMode)
																	: "Recorded activity"}
														</li>
													))}
												</ul>
											) : (
												<p className="mt-2 text-sm text-muted-foreground">No ranked results yet.</p>
											)}
										</div>
									))}
								</div>
							</section>
						))}
					</div>
				)}
			</AsyncStateView>

			<AsyncStateView
				isLoading={playsQuery.isLoading}
				isError={playsQuery.isError}
				error={playsQuery.error}
				onRetry={() => void playsQuery.refetch()}
				errorTitle="Couldn't load Tautulli plays by date"
				loadingFallback={<div className="h-40 animate-pulse rounded-xl bg-muted/10" />}
				emptyState={{ icon: BarChart3, title: "No plays by date", description: "" }}
			>
				{plays && (
					<section className="rounded-xl border border-border/50 bg-card/30 p-4">
						<h2 className="font-medium">Plays by date</h2>
						<div className="mt-3 grid gap-4 lg:grid-cols-2">
							{plays.sources.map((source) => (
								<div key={source.instanceId} className="rounded-lg border border-border/40 p-3">
									<p className="text-sm text-muted-foreground">
										{sourceLabel(source.instanceLabel, incognitoMode)}
									</p>
									{source.series.map((series) => (
										<div key={series.name} className="mt-3">
											<p className="text-sm font-medium">{series.name}</p>
											{series.data.length > 1 ? (
												<Sparkline data={series.data} color={ACCENT.from} fillColor={ACCENT.from} />
											) : (
												<p className="text-sm text-muted-foreground">Not enough data yet.</p>
											)}
										</div>
									))}
								</div>
							))}
						</div>
					</section>
				)}
			</AsyncStateView>

			<AsyncStateView
				isLoading={historyQuery.isLoading}
				isError={historyQuery.isError}
				error={historyQuery.error}
				onRetry={() => void historyQuery.refetch()}
				errorTitle="Couldn't load Tautulli watch history"
				loadingFallback={<div className="h-40 animate-pulse rounded-xl bg-muted/10" />}
				emptyState={{ icon: History, title: "No Tautulli watch history", description: "" }}
			>
				{history && (
					<section className="rounded-xl border border-border/50 bg-card/30 p-4">
						<h2 className="flex items-center gap-2 font-medium">
							<History className="h-4 w-4" /> Watch history
						</h2>
						<div className="mt-3 space-y-2">
							{history.sources.flatMap((source) =>
								source.history.map((item) => (
									<div
										key={`${source.instanceId}-${item.ratingKey}-${item.watchedAt}`}
										className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/40 p-3 text-sm"
									>
										<div>
											<p className="font-medium">{titleLabel(item.title, incognitoMode)}</p>
											<p className="text-muted-foreground">
												{userLabel(item.user, incognitoMode)} ·{" "}
												{sourceLabel(item.instanceLabel, incognitoMode)}
											</p>
										</div>
										<Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
									</div>
								)),
							)}
						</div>
					</section>
				)}
			</AsyncStateView>
		</div>
	);
}
