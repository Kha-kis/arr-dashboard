import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type ArrService, correlateSabQueue } from "../lib/sabnzbd/arr-correlation.js";
import { asRecord, pageParams, sabCall, text } from "../lib/sabnzbd/client.js";
import { getStoredHttpAuthHeaders } from "../lib/services/http-auth.js";
import { validateRequest } from "../lib/utils/validate.js";

const SABNZBD_SERVICE = "SABNZBD";
const DEFAULT_HISTORY_LIMIT = 20;
const MAX_QUEUE_LIMIT = 100;

type Coverage = "complete" | "partial" | "unavailable";

type Job = {
	nzoId: string;
	name: string;
	status: string;
	size: string;
	sizeLeft: string;
	timeLeft: string;
	percentage: string;
	category: string;
	priority: string;
	library: null;
};

type HistoryItem = {
	nzoId: string;
	name: string;
	status: string;
	size: string;
	completedAt: string;
	failMessage: string;
	category: string;
	library: null;
};

function nonNegativeCount(value: unknown): number | null {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && /^\d+$/.test(value)
				? Number(value)
				: Number.NaN;
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function safeText(value: unknown, maximum = 160): string {
	return text(value)
		.replace(/https?:\/\/\S+/gi, "[URL]")
		.replace(/(?:[A-Za-z]:\\|\/)[^\s]*/g, "[path]")
		.replace(/[\r\n\t]+/g, " ")
		.slice(0, maximum);
}

function queueItems(value: unknown): Job[] | null {
	const queue = asRecord(value);
	if (!Array.isArray(queue.slots)) return null;
	const rows = queue.slots.slice(0, MAX_QUEUE_LIMIT);
	const ids = new Set<string>();
	const result: Job[] = [];
	for (const item of rows) {
		const row = asRecord(item);
		const nzoId = typeof row.nzo_id === "string" ? row.nzo_id : "";
		if (!safeNzoId(nzoId) || ids.has(nzoId)) return null;
		ids.add(nzoId);
		result.push({
			nzoId,
			name: safeText(row.filename ?? row.name, 240),
			status: safeText(row.status, 80),
			size: safeText(row.size, 40),
			sizeLeft: safeText(row.sizeleft, 40),
			timeLeft: safeText(row.timeleft, 40),
			percentage: safeText(row.percentage, 16),
			category: safeText(row.cat ?? row.category, 80),
			priority: safeText(row.priority, 40),
			library: null,
		});
	}
	return result;
}

function historyItems(value: unknown, maximum = DEFAULT_HISTORY_LIMIT): HistoryItem[] | null {
	const history = asRecord(value);
	if (!Array.isArray(history.slots)) return null;
	const rows = history.slots.slice(0, maximum);
	const ids = new Set<string>();
	const result: HistoryItem[] = [];
	for (const item of rows) {
		const row = asRecord(item);
		if (typeof row.status !== "string" || row.status.trim().length === 0) return null;
		const nzoId = typeof row.nzo_id === "string" ? row.nzo_id : "";
		if (!safeNzoId(nzoId) || ids.has(nzoId)) return null;
		ids.add(nzoId);
		const completed = Number(row.completed);
		const completedDate =
			Number.isFinite(completed) && completed > 0 ? new Date(completed * 1000) : null;
		const completedAt =
			completedDate && Number.isFinite(completedDate.getTime()) ? completedDate.toISOString() : "";
		const failed = safeText(row.status, 80).toLowerCase().includes("fail");
		result.push({
			nzoId,
			name: safeText(row.name ?? row.nzb_name, 240),
			status: safeText(row.status, 80),
			size: safeText(row.size, 40),
			completedAt,
			// Provider fail text can contain paths, article details, or secrets. Keep an actionable category only.
			failMessage: failed ? "SABnzbd marked this job as failed." : "",
			category: safeText(row.category, 80),
			library: null,
		});
	}
	return result;
}

function queueStats(queueValue: unknown) {
	const queue = asRecord(queueValue);
	const pausedValue = queue.paused;
	const parsedSpeed = typeof queue.kbpersec === "number" ? queue.kbpersec : Number(queue.kbpersec);
	const rawSlotCount = queue.noofslots_total ?? queue.noofslots;
	const parsedSlotCount = nonNegativeCount(rawSlotCount);
	const slotCountKnown = parsedSlotCount !== null;
	const visibleSlotCount = Array.isArray(queue.slots) ? queue.slots.length : 0;
	return {
		version: safeText(queue.version, 40) || "unknown",
		paused: pausedValue === true || pausedValue === "true",
		status: safeText(queue.status, 80) || "Unknown",
		speed: safeText(queue.speed, 40),
		kbPerSec: Number.isFinite(parsedSpeed) && parsedSpeed >= 0 ? parsedSpeed : 0,
		sizeLeft: safeText(queue.sizeleft, 40),
		timeLeft: safeText(queue.timeleft, 40),
		diskFree: safeText(queue.diskspace1, 40),
		diskTotal: safeText(queue.diskspacetotal1, 40),
		queueCount: slotCountKnown ? Math.min(parsedSlotCount, 1_000_000) : visibleSlotCount,
		queueCountKnown: slotCountKnown,
		pausedJobs: 0,
	};
}

function normalizeWarnings(value: unknown): Array<{ text: string }> | null {
	const body = asRecord(value);
	if (!Array.isArray(body.warnings)) return null;
	return body.warnings.slice(0, 20).flatMap((warning): Array<{ text: string }> => {
		const textValue = safeText(asRecord(warning).text, 240);
		return textValue ? [{ text: "SABnzbd reported a warning." }] : [];
	});
}

function categories(value: unknown): string[] | null {
	const body = asRecord(value);
	if (!Array.isArray(body.categories)) return null;
	return body.categories.slice(0, 100).flatMap((category): string[] => {
		const name = safeText(category, 80);
		return name ? [name] : [];
	});
}

async function readInstance(
	app: Parameters<FastifyPluginAsync>[0],
	instance: {
		id: string;
		label: string;
		baseUrl: string;
		encryptedApiKey: string;
		encryptionIv: string;
		encryptedHttpAuthCredentials?: string | null;
		httpAuthEncryptionIv?: string | null;
	},
) {
	let apiKey: string;
	let requestHeaders: Record<string, string>;
	try {
		apiKey = app.encryptor.decrypt({
			value: instance.encryptedApiKey,
			iv: instance.encryptionIv,
		});
		requestHeaders = getStoredHttpAuthHeaders(app.encryptor, instance);
	} catch {
		return {
			id: instance.id,
			label: safeText(instance.label, 120),
			reachable: false,
			version: "unknown",
			paused: false,
			status: "Unavailable",
			speed: "",
			kbPerSec: 0,
			sizeLeft: "",
			timeLeft: "",
			diskFree: "",
			diskTotal: "",
			queueCount: 0,
			pausedJobs: 0,
			failedRecent: 0,
			categories: [],
			queue: [],
			history: [],
			warnings: [],
			attention: [],
			queueCoverage: "unavailable" as Coverage,
			historyCoverage: "unavailable" as Coverage,
			error: "Saved credentials could not be read.",
		};
	}

	const reads = await Promise.allSettled([
		sabCall(
			instance.baseUrl,
			apiKey,
			{
				mode: "queue",
				start: "0",
				limit: String(MAX_QUEUE_LIMIT),
			},
			{ headers: requestHeaders },
		),
		sabCall(
			instance.baseUrl,
			apiKey,
			{
				mode: "history",
				start: "0",
				limit: String(DEFAULT_HISTORY_LIMIT),
			},
			{ headers: requestHeaders },
		),
		sabCall(instance.baseUrl, apiKey, { mode: "warnings" }, { headers: requestHeaders }),
		sabCall(instance.baseUrl, apiKey, { mode: "get_cats" }, { headers: requestHeaders }),
	]);
	const queueBody = reads[0]?.status === "fulfilled" ? asRecord(reads[0].value).queue : null;
	const historyBody =
		reads[1]?.status === "fulfilled" ? asRecord(asRecord(reads[1].value).history) : null;
	const queue = queueItems(queueBody);
	const history = historyItems(historyBody);
	const warningItems = reads[2]?.status === "fulfilled" ? normalizeWarnings(reads[2].value) : null;
	const categoryItems = reads[3]?.status === "fulfilled" ? categories(reads[3].value) : null;
	const reachable = reads.some((read) => read.status === "fulfilled");
	const pausedJobs = queue?.filter((job) => job.status.toLowerCase() === "paused").length ?? 0;
	const failedRecent =
		history?.filter((item) => item.status.toLowerCase().includes("fail")).length ?? 0;
	const stats = queueStats(queueBody);
	const queueCoverage: Coverage =
		queue === null
			? "unavailable"
			: !stats.queueCountKnown || stats.queueCount > (queue?.length ?? 0)
				? "partial"
				: "complete";
	const rawHistoryTotal = historyBody?.noofslots;
	const parsedHistoryTotal = nonNegativeCount(rawHistoryTotal);
	const historyTotalKnown = parsedHistoryTotal !== null;
	const historyTotal = historyTotalKnown ? Math.min(parsedHistoryTotal, 1_000_000) : 0;
	const historyCoverage: Coverage =
		history === null
			? "unavailable"
			: !historyTotalKnown || historyTotal > (history?.length ?? 0)
				? "partial"
				: "complete";
	const coverageGaps = [
		queueCoverage,
		historyCoverage,
		warningItems === null ? "unavailable" : "complete",
	].filter((coverage) => coverage !== "complete").length;
	return {
		id: instance.id,
		label: safeText(instance.label, 120),
		reachable,
		...stats,
		pausedJobs,
		failedRecent,
		categories: categoryItems ?? [],
		queue: queue ?? [],
		history: history ?? [],
		warnings: warningItems ?? [],
		attention: [],
		queueCoverage,
		historyCoverage,
		error: reachable
			? coverageGaps > 0
				? "Some SABnzbd data is temporarily unavailable."
				: undefined
			: "Could not connect to SABnzbd.",
	};
}

const RESERVED_IDS = new Set(["all", "failed", "completed"]);

function safeNzoId(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 200 &&
		!value.includes(",") &&
		value.trim() === value &&
		!RESERVED_IDS.has(value.toLowerCase()) &&
		![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
	);
}

function providerStatusOk(value: unknown): boolean {
	return asRecord(value).status === true;
}

function providerPriorityPositionOk(value: unknown): boolean {
	const position = asRecord(value).position;
	return typeof position === "number" && Number.isSafeInteger(position) && position >= 0;
}

type ExactLookup<T> = { state: "found"; item: T } | { state: "absent" } | { state: "unavailable" };

function exactFilteredLookup<T>(
	value: unknown,
	envelopeKey: "queue" | "history",
	nzoId: string,
): ExactLookup<T> {
	const envelope = asRecord(asRecord(value)[envelopeKey]);
	if (!Array.isArray(envelope.slots)) return { state: "unavailable" };
	const count = nonNegativeCount(envelope.noofslots);
	if (count === null || count > 2 || envelope.slots.length > 2) return { state: "unavailable" };
	if (count === 0 && envelope.slots.length === 0) return { state: "absent" };
	if (count !== 1 || envelope.slots.length !== 1) return { state: "unavailable" };
	const item = asRecord(envelope.slots[0]);
	return typeof item.nzo_id === "string" && safeNzoId(item.nzo_id) && item.nzo_id === nzoId
		? { state: "found", item: item as T }
		: { state: "unavailable" };
}

async function findExactQueueJob(
	baseUrl: string,
	apiKey: string,
	nzoId: string,
	headers?: HeadersInit,
): Promise<ExactLookup<Record<string, unknown>>> {
	const body = await sabCall(
		baseUrl,
		apiKey,
		{ mode: "queue", nzo_ids: nzoId, start: "0", limit: "2" },
		{ headers },
	);
	return exactFilteredLookup(body, "queue", nzoId);
}

async function findExactHistoryItem(
	baseUrl: string,
	apiKey: string,
	nzoId: string,
	headers?: HeadersInit,
): Promise<ExactLookup<Record<string, unknown>>> {
	const body = await sabCall(
		baseUrl,
		apiKey,
		{ mode: "history", nzo_ids: nzoId, start: "0", limit: "2" },
		{ headers },
	);
	return exactFilteredLookup(body, "history", nzoId);
}

export const registerSabnzbdRoutes: FastifyPluginAsync = async (app) => {
	const instanceParams = z.object({ id: z.string().min(1).max(128) });
	const jobParams = instanceParams.extend({ jobId: z.string().max(200) });
	const actionBody = z.discriminatedUnion("action", [
		z.object({ action: z.enum(["pause", "resume", "delete"]), confirmed: z.boolean().optional() }),
		z.object({ action: z.literal("priority"), priority: z.enum(["-1", "0", "1", "2"]) }),
		z.object({ action: z.literal("category"), category: z.string().min(1).max(80) }),
	]);
	const confirmationBody = z.object({ confirmed: z.literal(true) });
	const globalParams = instanceParams.extend({ action: z.enum(["pause", "resume"]) });
	const sameEnabledConnection = async (instance: {
		id: string;
		userId: string;
		baseUrl: string;
		encryptedApiKey: string;
		encryptionIv: string;
		encryptedHttpAuthCredentials: string | null;
		httpAuthEncryptionIv: string | null;
	}) => {
		const current = await app.prisma.serviceInstance.findFirst({
			where: { id: instance.id, userId: instance.userId, service: SABNZBD_SERVICE, enabled: true },
		});
		return Boolean(
			current &&
				current.baseUrl === instance.baseUrl &&
				current.encryptedApiKey === instance.encryptedApiKey &&
				current.encryptionIv === instance.encryptionIv &&
				current.encryptedHttpAuthCredentials === instance.encryptedHttpAuthCredentials &&
				current.httpAuthEncryptionIv === instance.httpAuthEncryptionIv,
		);
	};
	const pausedState = (queue: Record<string, unknown>): boolean | null => {
		const value = queue.paused;
		if (value === true || value === "true") return true;
		if (value === false || value === "false") return false;
		return null;
	};
	const KNOWN_QUEUE_STATUSES = new Set([
		"queued",
		"downloading",
		"paused",
		"propagating",
		"fetching",
		"quickcheck",
		"verifying",
		"repairing",
		"extracting",
		"moving",
		"running",
	]);
	const ACTIVE_QUEUE_STATUSES = new Set([
		"queued",
		"downloading",
		"propagating",
		"fetching",
		"quickcheck",
		"verifying",
		"repairing",
		"extracting",
		"moving",
		"running",
	]);

	const getOwned = async (
		request: { currentUser?: { id: string } | null },
		id: string,
		reply: { status: (code: number) => { send: (body: unknown) => unknown } },
	) => {
		const instance = await app.prisma.serviceInstance.findFirst({
			where: { id, userId: request.currentUser!.id, service: SABNZBD_SERVICE, enabled: true },
		});
		if (!instance) {
			reply.status(404).send({ error: "SABnzbd instance not found" });
			return null;
		}
		try {
			return {
				...instance,
				requestHeaders: getStoredHttpAuthHeaders(app.encryptor, instance),
				apiKey: app.encryptor.decrypt({
					value: instance.encryptedApiKey,
					iv: instance.encryptionIv,
				}),
			};
		} catch {
			reply.status(503).send({ error: "Saved SABnzbd credentials are unavailable" });
			return null;
		}
	};

	app.post("/:id/:action", async (request, reply) => {
		const { id, action } = validateRequest(globalParams, asRecord(request.params));
		const instance = await getOwned(request, id, reply);
		if (!instance) return;
		let mutationResponse: unknown;
		try {
			if (!(await sameEnabledConnection(instance)))
				return reply.status(409).send({
					outcome: "refused",
					message: "The saved instance changed. Refresh before acting.",
				});
			mutationResponse = await sabCall(
				instance.baseUrl,
				instance.apiKey,
				{ mode: action },
				{ headers: instance.requestHeaders },
			);
			const statusOk = providerStatusOk(mutationResponse);
			const readback = asRecord(
				asRecord(
					await sabCall(
						instance.baseUrl,
						instance.apiKey,
						{
							mode: "queue",
							start: "0",
							limit: "1",
						},
						{ headers: instance.requestHeaders },
					),
				).queue,
			);
			const paused = pausedState(readback);
			const verified = statusOk && paused !== null && paused === (action === "pause");
			return reply.status(verified ? 200 : 202).send({
				outcome: verified ? "verified" : "unconfirmed",
				message: verified
					? `Queue ${action} confirmed.`
					: "The command may have been accepted, but the queue state could not be confirmed. Refresh status before acting again.",
			});
		} catch {
			return reply.status(202).send({
				outcome: "unconfirmed",
				message:
					"The command outcome could not be confirmed. Refresh status before acting again; it was not repeated.",
			});
		}
	});

	app.post("/:id/jobs/:jobId", async (request, reply) => {
		const { id, jobId } = validateRequest(jobParams, request.params);
		const body = validateRequest(actionBody, request.body);
		if (!safeNzoId(jobId))
			return reply.status(400).send({ error: "Invalid individual job identity" });
		if (body.action === "delete" && body.confirmed !== true)
			return reply.status(400).send({ error: "Explicit confirmation is required" });
		const instance = await getOwned(request, id, reply);
		if (!instance) return;
		try {
			const current = await findExactQueueJob(
				instance.baseUrl,
				instance.apiKey,
				jobId,
				instance.requestHeaders,
			);
			if (current.state !== "found")
				return reply.status(409).send({
					outcome: "refused",
					message: "This exact queue item is no longer available. Refresh the queue before acting.",
				});
			let params: Record<string, string>;
			switch (body.action) {
				case "pause":
				case "resume":
					if (!KNOWN_QUEUE_STATUSES.has(text(current.item.status).toLowerCase()))
						return reply.status(409).send({
							outcome: "refused",
							message: "The exact job state is unavailable. Refresh before acting.",
						});
					params = { mode: "queue", name: body.action, value: jobId };
					break;
				case "delete":
					params = { mode: "queue", name: "delete", value: jobId, del_files: "0" };
					break;
				case "priority":
					params = { mode: "queue", name: "priority", value: jobId, value2: body.priority };
					break;
				case "category": {
					const categoryBody = asRecord(
						await sabCall(
							instance.baseUrl,
							instance.apiKey,
							{ mode: "get_cats" },
							{ headers: instance.requestHeaders },
						),
					);
					const categories = categoryBody.categories;
					if (
						!Array.isArray(categories) ||
						!categories.some((category) => text(category) === body.category)
					)
						return reply
							.status(400)
							.send({ error: "Choose a category currently reported by SABnzbd" });
					params = { mode: "change_cat", value: jobId, value2: body.category };
					break;
				}
			}
			if (!(await sameEnabledConnection(instance)))
				return reply.status(409).send({
					outcome: "refused",
					message: "The saved instance changed. Refresh before acting.",
				});
			const providerResponse = await sabCall(instance.baseUrl, instance.apiKey, params, {
				headers: instance.requestHeaders,
			});
			const providerAccepted =
				body.action === "priority"
					? providerPriorityPositionOk(providerResponse)
					: providerStatusOk(providerResponse);
			if (!providerAccepted)
				return reply.status(202).send({
					outcome: "unconfirmed",
					message:
						"SABnzbd did not confirm the requested action. Refresh the queue before acting again.",
				});
			const after = await findExactQueueJob(
				instance.baseUrl,
				instance.apiKey,
				jobId,
				instance.requestHeaders,
			);
			let verified = false;
			if (body.action === "delete") verified = after.state === "absent";
			else if (after.state === "found") {
				switch (body.action) {
					case "pause":
						verified = text(after.item.status).toLowerCase() === "paused";
						break;
					case "resume":
						verified = ACTIVE_QUEUE_STATUSES.has(text(after.item.status).toLowerCase());
						break;
					case "priority":
						verified =
							text(after.item.priority).toLowerCase() ===
								({ "-1": "low", "0": "normal", "1": "high", "2": "force" } as const)[
									body.priority
								].toLowerCase() || text(after.item.priority) === body.priority;
						break;
					case "category":
						verified = text(after.item.cat ?? after.item.category) === body.category;
						break;
				}
			}
			return reply.status(verified ? 200 : 202).send({
				outcome: verified ? "verified" : "unconfirmed",
				message: verified
					? "SABnzbd state change confirmed."
					: "The command may have been accepted, but the exact item change could not be confirmed. Refresh before acting again.",
			});
		} catch {
			return reply.status(202).send({
				outcome: "unconfirmed",
				message:
					"The command outcome could not be confirmed. Refresh before acting again; the command was not replayed.",
			});
		}
	});

	app.post("/:id/history/:jobId/retry", async (request, reply) => {
		const { id, jobId } = validateRequest(jobParams, request.params);
		if (!safeNzoId(jobId))
			return reply.status(400).send({ error: "Invalid individual history identity" });
		const instance = await getOwned(request, id, reply);
		if (!instance) return;
		try {
			const current = await findExactHistoryItem(
				instance.baseUrl,
				instance.apiKey,
				jobId,
				instance.requestHeaders,
			);
			if (current.state !== "found" || text(current.item.status).toLowerCase() !== "failed")
				return reply.status(409).send({
					outcome: "refused",
					message:
						"This exact failed history item is no longer available. Refresh history before acting.",
				});
			if (!(await sameEnabledConnection(instance)))
				return reply.status(409).send({
					outcome: "refused",
					message: "The saved instance changed. Refresh before acting.",
				});
			const providerResponse = asRecord(
				await sabCall(
					instance.baseUrl,
					instance.apiKey,
					{ mode: "retry", value: jobId },
					{ headers: instance.requestHeaders },
				),
			);
			const newId = text(providerResponse.nzo_id);
			if (providerResponse.status !== true || !safeNzoId(newId) || newId === jobId)
				return reply.status(202).send({
					outcome: "unconfirmed",
					message:
						"Retry may have been accepted, but SABnzbd did not provide a verifiable replacement identity. Do not retry again until history and queue are reconciled.",
				});
			const [oldHistory, replacement] = await Promise.all([
				findExactHistoryItem(instance.baseUrl, instance.apiKey, jobId, instance.requestHeaders),
				findExactQueueJob(instance.baseUrl, instance.apiKey, newId, instance.requestHeaders),
			]);
			const verified = oldHistory.state === "absent" && replacement.state === "found";
			return reply.status(verified ? 200 : 202).send({
				outcome: verified ? "verified" : "unconfirmed",
				replacementId: verified ? newId : undefined,
				message: verified
					? "Retry confirmed as a new queue item."
					: "Retry may have been accepted. Reconcile history and queue before taking another action.",
			});
		} catch {
			return reply.status(202).send({
				outcome: "unconfirmed",
				message:
					"Retry outcome could not be confirmed. Reconcile history and queue before acting again; the request was not replayed.",
			});
		}
	});

	app.post("/:id/history/:jobId/remove", async (request, reply) => {
		const { id, jobId } = validateRequest(jobParams, request.params);
		validateRequest(confirmationBody, request.body);
		if (!safeNzoId(jobId))
			return reply.status(400).send({ error: "Invalid individual history identity" });
		const instance = await getOwned(request, id, reply);
		if (!instance) return;
		try {
			const current = await findExactHistoryItem(
				instance.baseUrl,
				instance.apiKey,
				jobId,
				instance.requestHeaders,
			);
			if (current.state !== "found")
				return reply.status(409).send({
					outcome: "refused",
					message: "This exact history item is no longer available. Refresh before acting.",
				});
			if (!(await sameEnabledConnection(instance)))
				return reply.status(409).send({
					outcome: "refused",
					message: "The saved instance changed. Refresh before acting.",
				});
			const result = await sabCall(
				instance.baseUrl,
				instance.apiKey,
				{
					mode: "history",
					name: "delete",
					value: jobId,
					archive: "0",
					del_files: "0",
				},
				{ headers: instance.requestHeaders },
			);
			if (!providerStatusOk(result))
				return reply.status(202).send({
					outcome: "unconfirmed",
					message:
						"SABnzbd did not confirm the history change. Refresh history before acting again.",
				});
			const verified =
				(
					await findExactHistoryItem(
						instance.baseUrl,
						instance.apiKey,
						jobId,
						instance.requestHeaders,
					)
				).state === "absent";
			return reply.status(verified ? 200 : 202).send({
				outcome: verified ? "verified" : "unconfirmed",
				message: verified
					? "History item removal confirmed; downloaded files were not requested for deletion."
					: "The change could not be confirmed. Refresh history before acting again.",
			});
		} catch {
			return reply.status(202).send({
				outcome: "unconfirmed",
				message:
					"History change could not be confirmed. Refresh history before acting again; the request was not replayed.",
			});
		}
	});
	app.get("/", async (request) => {
		const instances = await app.prisma.serviceInstance.findMany({
			where: {
				userId: request.currentUser!.id,
				service: SABNZBD_SERVICE,
				enabled: true,
			},
			orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
		});
		const projected = await Promise.all(instances.map((instance) => readInstance(app, instance)));
		return { configured: instances.length > 0, instances: projected };
	});

	app.get("/:id/correlation", async (request, reply) => {
		const { id } = validateRequest(z.object({ id: z.string().min(1).max(128) }), request.params);
		const userId = request.currentUser!.id;
		const sabInstance = await app.prisma.serviceInstance.findFirst({
			where: { id, userId, service: SABNZBD_SERVICE, enabled: true },
		});
		if (!sabInstance) return reply.status(404).send({ error: "SABnzbd instance not found" });
		let arrInstances: ArrService[];
		let queueBody: unknown;
		try {
			[arrInstances, queueBody] = await Promise.all([
				app.prisma.serviceInstance.findMany({
					where: { userId, service: { in: ["SONARR", "RADARR"] }, enabled: true },
					orderBy: [{ createdAt: "asc" }],
				}) as Promise<ArrService[]>,
				sabCall(
					sabInstance.baseUrl,
					app.encryptor.decrypt({
						value: sabInstance.encryptedApiKey,
						iv: sabInstance.encryptionIv,
					}),
					{ mode: "queue", start: "0", limit: String(MAX_QUEUE_LIMIT) },
					{
						headers: getStoredHttpAuthHeaders(app.encryptor, sabInstance),
					},
				),
			]);
		} catch {
			return reply
				.status(503)
				.send({ error: "SABnzbd queue matching is temporarily unavailable." });
		}
		const records = asRecord(asRecord(queueBody).queue).slots;
		if (!Array.isArray(records))
			return reply.status(503).send({ error: "SABnzbd queue is unavailable for matching." });
		const jobs = queueItems({ slots: records });
		if (!jobs)
			return reply
				.status(503)
				.send({ error: "SABnzbd queue identities are incomplete for matching." });
		const matches = await correlateSabQueue(
			app.arrClientFactory,
			sabInstance.baseUrl,
			jobs,
			arrInstances,
		);
		const total = queueStats(asRecord(queueBody).queue);
		return {
			coverage:
				total.queueCountKnown && total.queueCount === jobs.length && matches.size === jobs.length
					? "complete"
					: "partial",
			matches: Object.fromEntries(matches),
		};
	});

	app.get("/:id/history", async (request, reply) => {
		const { id } = validateRequest(z.object({ id: z.string().min(1).max(128) }), request.params);
		const { start, limit } = validateRequest(
			z.object({
				start: z.coerce.number().int().min(0).max(1_000_000).default(0),
				limit: z.coerce.number().int().min(1).max(100).default(DEFAULT_HISTORY_LIMIT),
			}),
			request.query,
		);
		const instance = await app.prisma.serviceInstance.findFirst({
			where: { id, userId: request.currentUser!.id, service: SABNZBD_SERVICE, enabled: true },
		});
		if (!instance) return reply.status(404).send({ error: "SABnzbd instance not found" });

		let apiKey: string;
		try {
			apiKey = app.encryptor.decrypt({
				value: instance.encryptedApiKey,
				iv: instance.encryptionIv,
			});
		} catch {
			return reply.status(503).send({ error: "Saved SABnzbd credentials are unavailable" });
		}
		const page = pageParams(start, limit);
		const body = asRecord(
			await sabCall(
				instance.baseUrl,
				apiKey,
				{
					mode: "history",
					start: String(page.start),
					limit: String(page.limit),
				},
				{ headers: getStoredHttpAuthHeaders(app.encryptor, instance) },
			),
		);
		const history = asRecord(body.history);
		const items = historyItems(history, page.limit);
		if (!items)
			return reply.status(502).send({ error: "SABnzbd returned incomplete history data" });
		const historyTotal = nonNegativeCount(history.noofslots);
		return {
			items,
			start: page.start,
			limit: page.limit,
			total: historyTotal === null ? 0 : Math.min(historyTotal, 1_000_000),
			coverage:
				historyTotal !== null && page.start + items.length >= historyTotal
					? ("complete" as const)
					: ("partial" as const),
		};
	});
};
