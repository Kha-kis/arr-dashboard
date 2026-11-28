import { notificationChannelTypeSchema } from "@arr/shared";
import {
	assertRestoreRuntimeOperation,
	getRestoreRuntimeClientContext,
	type RestoreRuntime,
} from "../backup/restore-runtime-admission.js";
import { withCleanupOperationGuard } from "../library-cleanup/cleanup-maintenance-gate.js";
import type { NotificationDispatcher } from "./notification-dispatcher.js";
import type { createNotificationOutboxRepository } from "./outbox-repository.js";
import { NotificationOutboxError } from "./outbox-types.js";
import type { NotificationLogger, SendResult } from "./types.js";

const POLL_INTERVAL_MS = 60_000;
const MIN_WAKE_DELAY_MS = 100;
const MAX_PASSES_PER_WAKE = 2;

/** Timers are wakeups only. Every dispatch grant and outcome belongs to the database. */
export function createNotificationOutboxWorker(options: {
	repository: ReturnType<typeof createNotificationOutboxRepository>;
	runtime: RestoreRuntime;
	dispatcher: Pick<NotificationDispatcher, "send" | "hasSender">;
	logger: NotificationLogger;
	clock?: () => Date;
}) {
	const { repository, runtime, dispatcher, logger } = options;
	getRestoreRuntimeClientContext(runtime);
	const clock = options.clock ?? (() => new Date());
	let started = false;
	let closed = false;
	let requested = false;
	let active: Promise<void> | null = null;
	let initialization: Promise<void> | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const unavailable = (operation: string) =>
		logger.warn(
			{ operation, status: "unavailable" },
			"Notification work remains pending or unconfirmed",
		);
	const run = <T>(operation: () => Promise<T>) =>
		runtime.runIndependentOperation(() =>
			withCleanupOperationGuard(async () => {
				await assertRestoreRuntimeOperation(runtime);
				return operation();
			}),
		);
	async function processPass(): Promise<void> {
		const ids = await run(async () => {
			if (closed) return [];
			// A bad batch must not suppress independently valid, already-ready recipients.
			try {
				await repository.recoverInterrupted();
			} catch {
				unavailable("notification-recovery");
			}
			try {
				await repository.groupDue();
			} catch {
				unavailable("notification-grouping");
			}
			return repository.listDueDeliveryIds();
		});
		for (const id of ids) {
			if (closed) break;
			try {
				await run(async () => {
					if (closed) return;
					const attempt = await repository.beginAttempt(id);
					if (!attempt) return;
					let result: SendResult;
					try {
						const type = notificationChannelTypeSchema.parse(attempt.recipient.context.type);
						result = dispatcher.hasSender(type)
							? await dispatcher.send(type, attempt.recipient.config, attempt.payload)
							: { success: false, retryable: false, failureCategory: "unsupported" };
					} catch {
						// An exception is not proof that the provider failed to accept the request.
						try {
							await repository.finishAttempt(attempt, { outcome: "uncertain" });
						} catch {
							unavailable("notification-unconfirmed-outcome");
						}
						return;
					}
					try {
						const recorded = await repository.finishAttempt(attempt, result);
						if (!recorded) unavailable("notification-outcome-fence");
					} catch {
						// Keep the committed marker. Never turn bookkeeping failure into a resend.
						unavailable("notification-outcome-write");
					}
				});
			} catch {
				unavailable("notification-claim");
			}
		}
	}
	async function armTimer(): Promise<void> {
		if (closed || !started) return;
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		let delay = POLL_INTERVAL_MS;
		try {
			const status = await run(() => repository.readQueueStatus());
			const now = clock().getTime();
			if (status.oldestDueAt && Number.isFinite(now))
				delay = Math.min(delay, Math.max(MIN_WAKE_DELAY_MS, status.oldestDueAt.getTime() - now));
		} catch {
			unavailable("notification-queue-observation");
		}
		if (closed) return;
		if (requested) delay = MIN_WAKE_DELAY_MS;
		timer = setTimeout(() => {
			timer = null;
			void wake().catch(() => unavailable("notification-wake"));
		}, delay);
		timer.unref();
	}
	function wake(): Promise<void> {
		if (closed) return Promise.resolve();
		if (!started) return Promise.reject(new NotificationOutboxError("binding-unavailable"));
		requested = true;
		if (active) return active;
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		active = (async () => {
			try {
				for (let pass = 0; pass < MAX_PASSES_PER_WAKE && requested && !closed; pass++) {
					requested = false;
					await processPass();
				}
			} finally {
				try {
					await armTimer();
				} finally {
					active = null;
				}
			}
		})();
		return active;
	}
	function start(): Promise<void> {
		if (closed) return Promise.reject(new NotificationOutboxError("binding-unavailable"));
		if (initialization) return initialization;
		if (started) return wake();
		initialization = (async () => {
			try {
				await run(async () => {
					await assertRestoreRuntimeOperation(runtime);
				});
				if (closed) throw new NotificationOutboxError("binding-unavailable");
				started = true;
				await wake();
			} finally {
				initialization = null;
			}
		})();
		return initialization;
	}
	function closeAdmission(): void {
		closed = true;
		requested = false;
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	}
	async function drain(): Promise<void> {
		// Neither clearing a timer nor a caller's cancellation proves provider settlement.
		while (initialization || active) {
			await Promise.allSettled([initialization, active].filter((pending) => pending !== null));
		}
	}
	return Object.freeze({ start, wake, closeAdmission, drain });
}
