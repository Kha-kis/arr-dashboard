"use client";

import type { NotificationQueueObservation } from "@arr/shared";

interface NotificationQueueStatusProps {
	queue?: NotificationQueueObservation;
	isLoading: boolean;
	isFetching: boolean;
	isError: boolean;
	onRead: () => void;
}

/** A read-only snapshot, not delivery authority or a promise of completion. */
export function NotificationQueueStatus({
	queue,
	isLoading,
	isFetching,
	isError,
	onRead,
}: NotificationQueueStatusProps) {
	const observed = queue?.state === "observed" ? queue : undefined;
	const reading = isLoading || isFetching;
	const lastKnown = observed !== undefined && (isFetching || isError);
	const empty = observed
		? [...Object.values(observed.events), ...Object.values(observed.deliveries)].every(
				(count) => count === 0,
			)
		: false;

	return (
		<section
			aria-label="Notification queue"
			aria-busy={reading}
			className="min-w-0 space-y-3 rounded-xl border border-border/30 bg-muted/10 p-4"
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h3 className="text-sm font-semibold">Notification Queue</h3>
				<button
					type="button"
					onClick={onRead}
					disabled={reading}
					className="min-h-10 rounded-md border border-border/50 px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-muted/30 disabled:opacity-50"
				>
					Read queue status
				</button>
			</div>
			<p className="text-xs text-muted-foreground">
				Accepted events and recipient deliveries have different units. Queue counts are not included
				in delivery success rates.
			</p>
			{lastKnown ? (
				<p role="status" className="text-sm text-muted-foreground">
					{isFetching
						? "Showing last-known queue counts while refreshing."
						: "Showing last-known queue counts. The current read failed; read again to check."}
				</p>
			) : !observed && reading ? (
				<p role="status" className="text-sm text-muted-foreground">
					Reading notification queue. Counts are not yet available.
				</p>
			) : null}
			{observed ? (
				<>
					<p className="break-words text-xs text-muted-foreground">
						Observed at (UTC):{" "}
						<time dateTime={observed.observedAt} className="break-all">
							{observed.observedAt}
						</time>
					</p>
					<dl className="grid grid-cols-1 gap-3 min-[390px]:grid-cols-2 lg:grid-cols-4">
						{[
							["Ready events", observed.events.ready],
							["Deferred events", observed.events.deferred],
							["Aggregating events", observed.events.aggregating],
							["Ready recipients", observed.deliveries.ready],
							["Retry waiting recipients", observed.deliveries.retryWaiting],
							["Submitting recipients", observed.deliveries.submitting],
							["Unconfirmed recipients", observed.deliveries.uncertain],
						].map(([label, count]) => (
							<div key={label} className="min-w-0">
								<dt className="break-words text-xs text-muted-foreground">{label}</dt>
								<dd className="break-all text-lg font-semibold tabular-nums">{count}</dd>
							</div>
						))}
					</dl>
					{empty ? (
						<p className="text-sm text-muted-foreground">
							No queued or unconfirmed work was observed.
						</p>
					) : null}
					{observed.deliveries.submitting > 0 ? (
						<p className="text-sm text-muted-foreground">
							Submission started for these recipients, but its outcome is unconfirmed. Current
							progress is unknown; a stored submission marker does not prove a provider request is
							still active.
						</p>
					) : null}
					{observed.deliveries.uncertain > 0 ? (
						<p className="text-sm text-muted-foreground">
							Delivery is unconfirmed for these recipients. They are not automatically resent
							because a previous attempt may have reached the provider.
						</p>
					) : null}
					{observed.oldestDueAt !== null ? (
						<p className="break-words text-xs text-muted-foreground">
							Earliest due work (UTC):{" "}
							<time dateTime={observed.oldestDueAt} className="break-all">
								{observed.oldestDueAt}
							</time>
							. A due time is not a guaranteed delivery time.
						</p>
					) : null}
				</>
			) : !reading ? (
				<p role="status" className="text-sm text-muted-foreground">
					Queue status unavailable. No current queue counts can be established. Read again to check;
					this does not send or replay notifications.
				</p>
			) : null}
		</section>
	);
}
