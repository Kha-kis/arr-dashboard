import { randomUUID } from "node:crypto";
import type { DashboardStatisticsResponse } from "@arr/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { retainRestoreRuntimeOperation } from "../backup/restore-runtime-admission.js";
import {
	claimDashboardRefresh,
	failDashboardRefresh,
	publishDashboardSnapshot,
	renewDashboardRefreshClaim,
} from "./dashboard-statistics-snapshot.js";

type Collector = () => Promise<{ data: DashboardStatisticsResponse; partial: boolean }>;
const RENEW_INTERVAL_MS = 30_000;
const MAX_COLLECTION_MS = 10 * 60_000;

/** Admit one refresh, then let the GET return before any provider work starts. */
export async function requestDashboardStatisticsRefresh(
	app: FastifyInstance,
	userId: string,
	fingerprint: string,
	log: FastifyBaseLogger,
	collect: Collector,
): Promise<boolean> {
	// Capture accepted work while the admitting HTTP ticket is still active.
	const runtimeOperation = retainRestoreRuntimeOperation();
	const token = randomUUID();
	try {
		const admitted = await claimDashboardRefresh(
			app.prisma,
			userId,
			fingerprint,
			token,
			new Date(),
		);
		if (!admitted) {
			await runtimeOperation?.release();
			return false;
		}
	} catch (error) {
		await runtimeOperation?.release();
		throw error;
	}
	const warn = () => {
		try {
			log.warn(
				{ category: "dashboard-statistics-refresh-failed" },
				"Dashboard statistics refresh failed",
			);
		} catch {
			// Diagnostics cannot change the availability decision.
		}
	};
	setImmediate(() => {
		const refresh = async () => {
			const startedAt = Date.now();
			let renewal: Promise<void> | null = null;
			const heartbeat = setInterval(() => {
				if (renewal) return;
				if (Date.now() - startedAt >= MAX_COLLECTION_MS) {
					clearInterval(heartbeat);
					return;
				}
				renewal = renewDashboardRefreshClaim(app.prisma, userId, fingerprint, token, new Date())
					.then((renewed) => {
						if (!renewed) clearInterval(heartbeat);
					})
					.catch(() => {
						// A transient storage error can retry on the next tick; publication
						// still requires the live fenced claim in the database.
					})
					.finally(() => {
						renewal = null;
					});
			}, RENEW_INTERVAL_MS);
			heartbeat.unref();
			try {
				const collected = await collect();
				clearInterval(heartbeat);
				if (renewal) await renewal;
				const now = new Date();
				if (Date.now() - startedAt >= MAX_COLLECTION_MS) {
					await failDashboardRefresh(app.prisma, userId, fingerprint, token, now, "timeout");
					return;
				}
				const published = await publishDashboardSnapshot(
					app.prisma,
					userId,
					fingerprint,
					token,
					now,
					collected.data,
					collected.partial ? "partial" : "complete",
					now,
				);
				if (!published) {
					await failDashboardRefresh(app.prisma, userId, fingerprint, token, now, "unknown");
				}
			} catch {
				try {
					await failDashboardRefresh(
						app.prisma,
						userId,
						fingerprint,
						token,
						new Date(),
						"provider-unavailable",
					);
				} catch {
					// A failed claim settlement must not become an unhandled rejection.
				}
				warn();
			} finally {
				clearInterval(heartbeat);
				// A failed provider/settlement can leave an already-started renewal.
				// Its SQL must settle before this retained ticket and obligation end.
				if (renewal) await renewal;
			}
		};
		void (async () => {
			try {
				if (runtimeOperation) await runtimeOperation.run(refresh);
				else await refresh();
			} catch {
				// Detached admission failure leaves the durable claim honest for expiry.
				warn();
			} finally {
				// Release outside the retained execution's own ticket to avoid self-join.
				await runtimeOperation?.release();
			}
		})().catch(warn);
	});
	return true;
}
