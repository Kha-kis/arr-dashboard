/**
 * Pulse signals for SABnzbd.
 *
 * Mirrors collectQuiSignals: one rollup per problem, not one row per job.
 * Unreachable servers are critical. Warnings and failed history are warnings.
 */

import type { PulseItem } from "@arr/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { asRecord, sabCall, text } from "../sabnzbd/client.js";

export async function collectSabnzbdSignals(
	app: FastifyInstance,
	userId: string,
	log: FastifyBaseLogger,
): Promise<PulseItem[]> {
	const instances = await app.prisma.serviceInstance.findMany({
		where: { userId, service: "SABNZBD", enabled: true },
	});
	const items: PulseItem[] = [];
	const now = new Date().toISOString();

	for (const instance of instances) {
		let apiKey: string;
		try {
			apiKey = app.encryptor.decrypt({
				value: instance.encryptedApiKey,
				iv: instance.encryptionIv,
			});
		} catch (error) {
			log.warn({ err: error, instanceId: instance.id }, "pulse: sabnzbd decrypt failed");
			items.push({
				id: `sabnzbd-config-${instance.id}`,
				severity: "critical",
				category: "health",
				title: `${instance.label}: configuration error`,
				detail: "The saved SABnzbd API key could not be read. Re-save it under Settings \u2192 Services.",
				actionUrl: "/settings",
				actionLabel: "Re-save credentials",
				source: "sabnzbd",
				timestamp: now,
			});
			continue;
		}

		try {
			const [warningBody, historyBody] = await Promise.all([
				sabCall(instance.baseUrl, apiKey, { mode: "warnings" }),
				sabCall(instance.baseUrl, apiKey, { mode: "history", limit: "20" }),
			]);
			const warnings = asRecord(warningBody).warnings;
			const warningList = Array.isArray(warnings) ? warnings : [];
			if (warningList.length > 0) {
				const first = warningList[0];
				const sample =
					typeof first === "string" ? first : text(asRecord(first).text) || "SABnzbd reported a warning";
				items.push({
					id: `sabnzbd-warnings-${instance.id}`,
					severity: "warning",
					category: "operations",
					title: `${instance.label} has ${warningList.length} warning${warningList.length === 1 ? "" : "s"}`,
					detail: sample,
					actionUrl: "/sabnzbd",
					actionLabel: "Open SABnzbd",
					source: "sabnzbd",
					timestamp: now,
				});
			}
			const slots = asRecord(asRecord(historyBody).history).slots;
			const failed = (Array.isArray(slots) ? slots : []).filter((slot) => {
				const status = text(asRecord(slot).status).toLowerCase();
				return status === "failed" || status.includes("fail");
			});
			if (failed.length > 0) {
				const name = text(asRecord(failed[0]).name) || text(asRecord(failed[0]).filename);
				items.push({
					id: `sabnzbd-failed-${instance.id}`,
					severity: "warning",
					category: "operations",
					title: `${failed.length} recent SABnzbd job${failed.length === 1 ? "" : "s"} failed`,
					detail: name || "A download in recent history failed.",
					actionUrl: "/sabnzbd-activity",
					actionLabel: "Review history",
					source: "sabnzbd",
					timestamp: now,
				});
			}
		} catch (error) {
			log.warn({ err: error, instanceId: instance.id }, "pulse: sabnzbd unreachable");
			items.push({
				id: `sabnzbd-offline-${instance.id}`,
				severity: "critical",
				category: "health",
				title: `${instance.label} is unreachable`,
				detail: "Could not connect to SABnzbd.",
				actionUrl: "/sabnzbd",
				actionLabel: "Check connection",
				source: "sabnzbd",
				timestamp: now,
			});
		}
	}

	return items;
}
