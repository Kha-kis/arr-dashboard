import type { FastifyBaseLogger } from "fastify";
import type { ArrClientFactory } from "../arr/client-factory.js";
import type { Encryptor } from "../auth/encryption.js";
import type { NotificationService } from "../notifications/notification-service.js";
import type { PrismaClient } from "../prisma.js";
import {
	passthroughTickWrapper,
	type TickWrapper,
} from "../scheduler-registry/scheduler-registry.js";
import { executeCrossDomainRule } from "./cross-domain-executor.js";

const TICK_INTERVAL_MS = 5 * 60 * 1000;
const RULE_COOLDOWN_MS = 60 * 60 * 1000;

export class CrossDomainScheduler {
	private intervalId: NodeJS.Timeout | null = null;
	private inFlight = false;
	private trackTick: TickWrapper;

	constructor(
		private prisma: PrismaClient,
		private arrClientFactory: ArrClientFactory,
		private encryptor: Encryptor,
		private notificationService: NotificationService,
		private log: FastifyBaseLogger,
		options?: { trackTick?: TickWrapper },
	) {
		this.trackTick = options?.trackTick ?? passthroughTickWrapper;
	}

	start(): void {
		if (this.intervalId) return;
		this.trackTick(() => this.tick()).catch((error) =>
			this.log.error({ err: error }, "Initial cross-domain automation tick failed"),
		);
		this.intervalId = setInterval(() => {
			this.trackTick(() => this.tick()).catch((error) =>
				this.log.error({ err: error }, "Scheduled cross-domain automation tick failed"),
			);
		}, TICK_INTERVAL_MS);
	}

	stop(): void {
		if (this.intervalId) clearInterval(this.intervalId);
		this.intervalId = null;
	}

	private async tick(): Promise<void> {
		if (this.inFlight) return;
		this.inFlight = true;
		try {
			const cooldown = new Date(Date.now() - RULE_COOLDOWN_MS);
			const rules = await this.prisma.crossDomainRule.findMany({
				where: {
					deployedAt: { not: null },
					deployedDocument: { not: null },
					deployedName: { not: null },
					deployedScope: { not: null },
					deployedActions: { not: null },
					OR: [{ lastRunAt: null }, { lastRunAt: { lt: cooldown } }],
				},
			});
			for (const row of rules) {
				try {
					const result = await executeCrossDomainRule(
						{
							prisma: this.prisma,
							arrClientFactory: this.arrClientFactory,
							encryptor: this.encryptor,
							notificationService: this.notificationService,
							log: this.log,
						},
						{
							...row,
							deployedName: row.deployedName!,
							deployedDocument: row.deployedDocument!,
							deployedScope: row.deployedScope!,
							deployedActions: row.deployedActions!,
						},
					);
					await this.prisma.crossDomainRule.update({
						where: { id: row.id },
						data: {
							lastRunAt: new Date(),
							lastRunStatus: result.status,
							lastRunMessage: result.message,
						},
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					this.log.warn({ err: error, ruleId: row.id }, "Cross-domain rule execution failed");
					await this.prisma.crossDomainRule.update({
						where: { id: row.id },
						data: { lastRunAt: new Date(), lastRunStatus: "failed", lastRunMessage: message },
					});
				}
			}
		} finally {
			this.inFlight = false;
		}
	}
}
