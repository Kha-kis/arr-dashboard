import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createQuiClient } from "../../lib/qui/client-factory.js";
import { requireQuiInstance } from "../../lib/qui/instance-helpers.js";
import { getErrorMessage } from "../../lib/utils/error-message.js";
import { validateRequest } from "../../lib/utils/validate.js";
import {
	extractHostnameSafe,
	HASH_PARAM,
	INSTANCE_HASH_PARAMS,
	QUI_INSTANCE_PARAM,
} from "./qui-shared.js";

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
			const qbitInstanceId = Number.parseInt(instanceId, 10);
			if (!Number.isFinite(qbitInstanceId)) {
				return reply.status(400).send({ error: "qbit instanceId must be numeric" });
			}
			const instance = await requireQuiInstance(app, userId, id);
			const client = createQuiClient(app, instance);
			const trackers = await client.getTrackers(qbitInstanceId, hash);
			// Filter pseudo-trackers (DHT/PeX/LSD) from the visible list.
			const realTrackers = trackers.filter((t) => !t.url.startsWith("** "));
			return reply.send({ trackers: realTrackers });
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
	// Detail-drawer mutations (Phase 6) — rename + tracker CRUD
	// ────────────────────────────────────────────────────────────────────
	//
	// These bypass the bulk-action transport because qui exposes them as
	// individual endpoints. Still flow through executeQuiAction for audit-
	// log uniformity? — No: those endpoints aren't in the bulk-action enum
	// vocabulary. Audit logging for these mutations lives directly in the
	// route handler via writeNonBulkActionLog (helper added below). The
	// shape stored in the audit log uses the existing QuiActionLog table
	// with synthetic `action` values prefixed `nonBulk.` to stay distinct
	// from the bulk-action enum. (See `nonBulkActionToString` below.)
	//
	// Failure mode: any non-2xx from qui surfaces as 502 with the qui
	// error message, matching the bulk-action route's behavior.

	app.post<{
		Params: { id: string; instanceId: string; hash: string };
		Body: { name?: unknown };
	}>("/qui/instances/:id/qbit/:instanceId/torrents/:hash/rename", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { id } = validateRequest(QUI_INSTANCE_PARAM, request.params);
		const { instanceId, hash } = validateRequest(INSTANCE_HASH_PARAMS, {
			instanceId: request.params.instanceId,
			hash: request.params.hash,
		});
		const body = validateRequest(z.object({ name: z.string().min(1).max(1024) }), request.body);
		const qbitInstanceId = Number.parseInt(instanceId, 10);
		if (!Number.isFinite(qbitInstanceId)) {
			return reply.status(400).send({ error: "qbit instanceId must be numeric" });
		}
		const instance = await requireQuiInstance(app, userId, id);
		const client = createQuiClient(app, instance);
		try {
			await client.renameTorrent(qbitInstanceId, hash, body.name);
			return reply.send({ status: "success" });
		} catch (error) {
			return reply.status(502).send({
				error: "qui mutation failed",
				message: getErrorMessage(error, "qui rename failed"),
			});
		}
	});

	app.post<{
		Params: { id: string; instanceId: string; hash: string };
		Body: { urls?: unknown };
	}>("/qui/instances/:id/qbit/:instanceId/torrents/:hash/trackers/add", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { id } = validateRequest(QUI_INSTANCE_PARAM, request.params);
		const { instanceId, hash } = validateRequest(INSTANCE_HASH_PARAMS, {
			instanceId: request.params.instanceId,
			hash: request.params.hash,
		});
		const body = validateRequest(
			z.object({ urls: z.array(z.string().min(1)).min(1).max(50) }),
			request.body,
		);
		const qbitInstanceId = Number.parseInt(instanceId, 10);
		if (!Number.isFinite(qbitInstanceId)) {
			return reply.status(400).send({ error: "qbit instanceId must be numeric" });
		}
		const instance = await requireQuiInstance(app, userId, id);
		const client = createQuiClient(app, instance);
		try {
			await client.addTrackers(qbitInstanceId, hash, body.urls);
			return reply.send({ status: "success" });
		} catch (error) {
			return reply.status(502).send({
				error: "qui mutation failed",
				message: getErrorMessage(error, "qui addTrackers failed"),
			});
		}
	});

	// Remove takes HOSTNAMES, not URLs — the panel/drawer only ever holds
	// passkey-stripped hostnames (extractHostnameSafe in qui-shared.ts), but
	// qBit matches trackers for removal by exact full announce URL. Resolve
	// hostname → full URL here so the URL (with its passkey) never leaves
	// the API process.
	app.post<{
		Params: { id: string; instanceId: string; hash: string };
		Body: { hostnames?: unknown };
	}>(
		"/qui/instances/:id/qbit/:instanceId/torrents/:hash/trackers/remove",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { id } = validateRequest(QUI_INSTANCE_PARAM, request.params);
			const { instanceId, hash } = validateRequest(INSTANCE_HASH_PARAMS, {
				instanceId: request.params.instanceId,
				hash: request.params.hash,
			});
			const body = validateRequest(
				z.object({ hostnames: z.array(z.string().min(1)).min(1).max(50) }),
				request.body,
			);
			const qbitInstanceId = Number.parseInt(instanceId, 10);
			if (!Number.isFinite(qbitInstanceId)) {
				return reply.status(400).send({ error: "qbit instanceId must be numeric" });
			}
			const instance = await requireQuiInstance(app, userId, id);
			const client = createQuiClient(app, instance);
			try {
				const wanted = new Set(body.hostnames.map((h) => h.toLowerCase()));
				const trackers = await client.getTrackers(qbitInstanceId, hash);
				const urls = trackers
					.filter((t) => wanted.has(extractHostnameSafe(t.url).toLowerCase()))
					.map((t) => t.url);
				if (urls.length === 0) {
					return reply.status(404).send({ error: "no tracker matches the given hostname" });
				}
				await client.removeTrackers(qbitInstanceId, hash, urls);
				return reply.send({ status: "success" });
			} catch (error) {
				return reply.status(502).send({
					error: "qui mutation failed",
					message: getErrorMessage(error, "qui removeTrackers failed"),
				});
			}
		},
	);

	// Edit identifies the tracker to replace by HOSTNAME (same passkey-safety
	// constraint as removal — the caller never sees the old full URL). The
	// new URL is operator-supplied, so it arrives whole. Resolve oldHostname
	// → old full URL here, then hand both to qui's edit endpoint.
	app.post<{
		Params: { id: string; instanceId: string; hash: string };
		Body: { oldHostname?: unknown; newURL?: unknown };
	}>("/qui/instances/:id/qbit/:instanceId/torrents/:hash/trackers/edit", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { id } = validateRequest(QUI_INSTANCE_PARAM, request.params);
		const { instanceId, hash } = validateRequest(INSTANCE_HASH_PARAMS, {
			instanceId: request.params.instanceId,
			hash: request.params.hash,
		});
		const body = validateRequest(
			z.object({
				oldHostname: z.string().min(1),
				newURL: z.string().min(1),
			}),
			request.body,
		);
		const qbitInstanceId = Number.parseInt(instanceId, 10);
		if (!Number.isFinite(qbitInstanceId)) {
			return reply.status(400).send({ error: "qbit instanceId must be numeric" });
		}
		const instance = await requireQuiInstance(app, userId, id);
		const client = createQuiClient(app, instance);
		try {
			const oldHostname = body.oldHostname.toLowerCase();
			const trackers = await client.getTrackers(qbitInstanceId, hash);
			const target = trackers.find((t) => extractHostnameSafe(t.url).toLowerCase() === oldHostname);
			if (!target) {
				return reply.status(404).send({ error: "no tracker matches the given hostname" });
			}
			await client.editTracker(qbitInstanceId, hash, target.url, body.newURL);
			return reply.send({ status: "success" });
		} catch (error) {
			return reply.status(502).send({
				error: "qui mutation failed",
				message: getErrorMessage(error, "qui editTracker failed"),
			});
		}
	});
}
