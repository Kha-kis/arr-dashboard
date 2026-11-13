import type { FastifyInstance } from "fastify";
import { createQuiClient } from "../../lib/qui/client-factory.js";
import { executeQuiDrawerAction } from "../../lib/qui/drawer-action-service.js";
import { requireQuiInstance } from "../../lib/qui/instance-helpers.js";
import { projectQuiTrackerViews } from "../../lib/qui/tracker-selection.js";
import { getErrorMessage } from "../../lib/utils/error-message.js";
import { validateRequest } from "../../lib/utils/validate.js";
import {
	HASH_PARAM,
	INSTANCE_HASH_PARAMS,
	QUI_DRAWER_ADD_TRACKERS_BODY,
	QUI_DRAWER_EDIT_TRACKER_BODY,
	QUI_DRAWER_REMOVE_TRACKERS_BODY,
	QUI_DRAWER_RENAME_BODY,
	QUI_INSTANCE_PARAM,
} from "./qui-shared.js";

function sendDrawerResult(
	reply: import("fastify").FastifyReply,
	result: Awaited<ReturnType<typeof executeQuiDrawerAction>>,
) {
	if (result.status === "failed") {
		if (result.failureCategory === "tracker_lookup") {
			return reply.status(502).send({
				error: "qui tracker lookup failed",
				message: result.error,
			});
		}
		return reply.status(409).send({
			error:
				result.failureCategory === "selection"
					? "qui tracker selection unavailable"
					: "qui mutation unavailable",
			message: result.error,
		});
	}
	if (result.status === "uncertain") {
		return reply
			.status(502)
			.send({ error: "qui mutation outcome uncertain", message: result.error });
	}
	if (result.status === "audit_unsettled") {
		return reply.status(503).send({ error: "qui action audit unresolved", message: result.error });
	}
	return reply.send({ status: "success", logRowCount: result.logRowCount });
}

export function registerTorrentRoutes(app: FastifyInstance): void {
	app.get<{ Params: { id: string; hash: string } }>(
		"/qui/instances/:id/torrents/by-hash/:hash",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { id } = validateRequest(QUI_INSTANCE_PARAM, request.params);
			const { hash } = validateRequest(HASH_PARAM, { hash: request.params.hash });
			const instance = await requireQuiInstance(app, userId, id);
			const client = createQuiClient(app, instance);
			const torrent = await client.getTorrentByHash(hash);
			return reply.send({ torrent });
		},
	);

	app.get<{ Params: { id: string; instanceId: string; hash: string } }>(
		"/qui/instances/:id/qbit/:instanceId/torrents/:hash/trackers",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { id } = validateRequest(QUI_INSTANCE_PARAM, request.params);
			const { instanceId, hash } = validateRequest(INSTANCE_HASH_PARAMS, {
				instanceId: request.params.instanceId,
				hash: request.params.hash,
			});
			const qbitInstanceId = /^\d+$/.test(instanceId) ? Number(instanceId) : NaN;
			if (!Number.isSafeInteger(qbitInstanceId) || qbitInstanceId <= 0) {
				return reply.status(400).send({ error: "qbit instanceId must be numeric" });
			}
			const instance = await requireQuiInstance(app, userId, id);
			const client = createQuiClient(app, instance);
			const trackers = await client.getTrackers(qbitInstanceId, hash);
			return reply.send({
				trackers: projectQuiTrackerViews(
					app.encryptor,
					{ userId, serviceInstanceId: instance.id, qbitInstanceId, hash },
					trackers,
				),
			});
		},
	);

	app.get<{ Params: { id: string; instanceId: string; hash: string } }>(
		"/qui/instances/:id/qbit/:instanceId/torrents/:hash/cross-seed",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { id } = validateRequest(QUI_INSTANCE_PARAM, request.params);
			const { instanceId, hash } = validateRequest(INSTANCE_HASH_PARAMS, {
				instanceId: request.params.instanceId,
				hash: request.params.hash,
			});
			const qbitInstanceId = Number.parseInt(instanceId, 10);
			if (!Number.isFinite(qbitInstanceId)) {
				return reply.status(400).send({ error: "qbit instanceId must be numeric" });
			}
			const instance = await requireQuiInstance(app, userId, id);
			const client = createQuiClient(app, instance);
			const matches = await client.getCrossSeedMatches(qbitInstanceId, hash);
			return reply.send({ matches });
		},
	);

	// ────────────────────────────────────────────────────────────────────
	// Detail-drawer reads (Phase 6) — per-torrent properties + files
	// ────────────────────────────────────────────────────────────────────
	//
	// These power the drawer's "Status / Limits / Files" sections. Both
	// are lazy-loaded — the drawer opens with what we already have from
	// the cluster panel and fetches the heavier per-torrent details only
	// when the user expands the relevant section.

	app.get<{ Params: { id: string; instanceId: string; hash: string } }>(
		"/qui/instances/:id/qbit/:instanceId/torrents/:hash/properties",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { id } = validateRequest(QUI_INSTANCE_PARAM, request.params);
			const { instanceId, hash } = validateRequest(INSTANCE_HASH_PARAMS, {
				instanceId: request.params.instanceId,
				hash: request.params.hash,
			});
			const qbitInstanceId = Number.parseInt(instanceId, 10);
			if (!Number.isFinite(qbitInstanceId)) {
				return reply.status(400).send({ error: "qbit instanceId must be numeric" });
			}
			const instance = await requireQuiInstance(app, userId, id);
			const client = createQuiClient(app, instance);
			const properties = await client.getTorrentProperties(qbitInstanceId, hash);
			return reply.send({ properties });
		},
	);

	app.get<{
		Params: { id: string; instanceId: string; hash: string };
		Querystring: { refresh?: string };
	}>("/qui/instances/:id/qbit/:instanceId/torrents/:hash/files", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { id } = validateRequest(QUI_INSTANCE_PARAM, request.params);
		const { instanceId, hash } = validateRequest(INSTANCE_HASH_PARAMS, {
			instanceId: request.params.instanceId,
			hash: request.params.hash,
		});
		const qbitInstanceId = Number.parseInt(instanceId, 10);
		if (!Number.isFinite(qbitInstanceId)) {
			return reply.status(400).send({ error: "qbit instanceId must be numeric" });
		}
		const refresh = request.query?.refresh === "true";
		const instance = await requireQuiInstance(app, userId, id);
		const client = createQuiClient(app, instance);
		const files = await client.getTorrentFiles(qbitInstanceId, hash, { refresh });
		return reply.send({ files });
	});

	// MediaInfo for one file — qui runs MediaInfo against the on-disk file,
	// so this only works when qui has local filesystem access to the
	// torrent's data. Lazy: the drawer fetches it per file on demand.
	app.get<{
		Params: { id: string; instanceId: string; hash: string; fileIndex: string };
	}>(
		"/qui/instances/:id/qbit/:instanceId/torrents/:hash/files/:fileIndex/mediainfo",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { id } = validateRequest(QUI_INSTANCE_PARAM, request.params);
			const { instanceId, hash } = validateRequest(INSTANCE_HASH_PARAMS, {
				instanceId: request.params.instanceId,
				hash: request.params.hash,
			});
			const qbitInstanceId = Number.parseInt(instanceId, 10);
			const fileIndex = Number.parseInt(request.params.fileIndex, 10);
			if (!Number.isFinite(qbitInstanceId)) {
				return reply.status(400).send({ error: "qbit instanceId must be numeric" });
			}
			if (!Number.isInteger(fileIndex) || fileIndex < 0) {
				return reply.status(400).send({ error: "fileIndex must be a non-negative integer" });
			}
			const instance = await requireQuiInstance(app, userId, id);
			const client = createQuiClient(app, instance);
			try {
				const mediaInfo = await client.getFileMediaInfo(qbitInstanceId, hash, fileIndex);
				return reply.send({ mediaInfo });
			} catch (error) {
				return reply.status(502).send({
					error: "qui mediainfo failed",
					message: getErrorMessage(error, "qui getFileMediaInfo failed"),
				});
			}
		},
	);

	// ────────────────────────────────────────────────────────────────────
	// Drawer mutations share the same target verification, atomic hash claim,
	// audit intent, uncertainty hold, and success release as bulk actions.
	app.post<{ Params: { id: string; instanceId: string; hash: string }; Body: unknown }>(
		"/qui/instances/:id/qbit/:instanceId/torrents/:hash/rename",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { id } = validateRequest(QUI_INSTANCE_PARAM, request.params);
			const { instanceId, hash } = validateRequest(INSTANCE_HASH_PARAMS, request.params);
			const body = validateRequest(QUI_DRAWER_RENAME_BODY, request.body);
			const qbitInstanceId = /^\d+$/.test(instanceId) ? Number(instanceId) : NaN;
			if (!Number.isSafeInteger(qbitInstanceId) || qbitInstanceId <= 0) {
				return reply.status(400).send({ error: "qbit instanceId must be numeric" });
			}
			const instance = await requireQuiInstance(app, userId, id);
			const client = createQuiClient(app, instance);
			const result = await executeQuiDrawerAction({
				app,
				client,
				userId,
				serviceInstanceId: instance.id,
				qbitInstanceId,
				hash,
				operation: { action: "renameTorrent", input: body },
			});
			return sendDrawerResult(reply, result);
		},
	);

	app.post<{ Params: { id: string; instanceId: string; hash: string }; Body: unknown }>(
		"/qui/instances/:id/qbit/:instanceId/torrents/:hash/trackers/add",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { id } = validateRequest(QUI_INSTANCE_PARAM, request.params);
			const { instanceId, hash } = validateRequest(INSTANCE_HASH_PARAMS, request.params);
			const body = validateRequest(QUI_DRAWER_ADD_TRACKERS_BODY, request.body);
			const qbitInstanceId = /^\d+$/.test(instanceId) ? Number(instanceId) : NaN;
			if (!Number.isSafeInteger(qbitInstanceId) || qbitInstanceId <= 0) {
				return reply.status(400).send({ error: "qbit instanceId must be numeric" });
			}
			const instance = await requireQuiInstance(app, userId, id);
			const client = createQuiClient(app, instance);
			const result = await executeQuiDrawerAction({
				app,
				client,
				userId,
				serviceInstanceId: instance.id,
				qbitInstanceId,
				hash,
				operation: { action: "addTrackers", input: body },
			});
			return sendDrawerResult(reply, result);
		},
	);

	app.post<{ Params: { id: string; instanceId: string; hash: string }; Body: unknown }>(
		"/qui/instances/:id/qbit/:instanceId/torrents/:hash/trackers/remove",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { id } = validateRequest(QUI_INSTANCE_PARAM, request.params);
			const { instanceId, hash } = validateRequest(INSTANCE_HASH_PARAMS, request.params);
			const body = validateRequest(QUI_DRAWER_REMOVE_TRACKERS_BODY, request.body);
			const qbitInstanceId = /^\d+$/.test(instanceId) ? Number(instanceId) : NaN;
			if (!Number.isSafeInteger(qbitInstanceId) || qbitInstanceId <= 0) {
				return reply.status(400).send({ error: "qbit instanceId must be numeric" });
			}
			const instance = await requireQuiInstance(app, userId, id);
			const client = createQuiClient(app, instance);
			const result = await executeQuiDrawerAction({
				app,
				client,
				userId,
				serviceInstanceId: instance.id,
				qbitInstanceId,
				hash,
				operation: { action: "removeTrackers", input: body },
			});
			return sendDrawerResult(reply, result);
		},
	);

	app.post<{ Params: { id: string; instanceId: string; hash: string }; Body: unknown }>(
		"/qui/instances/:id/qbit/:instanceId/torrents/:hash/trackers/edit",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { id } = validateRequest(QUI_INSTANCE_PARAM, request.params);
			const { instanceId, hash } = validateRequest(INSTANCE_HASH_PARAMS, request.params);
			const body = validateRequest(QUI_DRAWER_EDIT_TRACKER_BODY, request.body);
			const qbitInstanceId = /^\d+$/.test(instanceId) ? Number(instanceId) : NaN;
			if (!Number.isSafeInteger(qbitInstanceId) || qbitInstanceId <= 0) {
				return reply.status(400).send({ error: "qbit instanceId must be numeric" });
			}
			const instance = await requireQuiInstance(app, userId, id);
			const client = createQuiClient(app, instance);
			const input =
				"trackerSelector" in body
					? { trackerSelectors: [body.trackerSelector], newURL: body.newURL }
					: { hostnames: [body.oldHostname], newURL: body.newURL };
			const result = await executeQuiDrawerAction({
				app,
				client,
				userId,
				serviceInstanceId: instance.id,
				qbitInstanceId,
				hash,
				operation: { action: "editTracker", input },
			});
			return sendDrawerResult(reply, result);
		},
	);
}
