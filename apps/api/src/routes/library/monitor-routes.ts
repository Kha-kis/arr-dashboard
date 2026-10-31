import {
	libraryAlbumMonitorRequestSchema,
	libraryBookMonitorRequestSchema,
	libraryEpisodeMonitorRequestSchema,
	libraryToggleMonitorRequestSchema,
} from "@arr/shared";
import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import {
	getClientForInstance,
	isLidarrClient,
	isRadarrClient,
	isReadarrClient,
	isSonarrClient,
} from "../../lib/arr/client-helpers.js";
import {
	areRequestedMonitorRowsConfirmed,
	isMonitoringResourceForTarget,
	isMonitoringStateConfirmed,
	isPositiveMonitoringId,
	monitoringSeasons,
	monitoringSourceWhere,
} from "../../lib/library/monitoring-confirmation.js";
import { normalizeSeasons } from "../../lib/library/series-normalizer.js";
import type { ServiceInstance } from "../../lib/prisma.js";
import { validateRequest } from "../../lib/utils/validate.js";

const unconfirmed = (reply: FastifyReply) =>
	reply.status(502).send({ error: "Monitoring update not confirmed." });
const sourceCurrent = async (app: FastifyInstance, instance: ServiceInstance) =>
	(await app.prisma.serviceInstance.findFirst({
		where: monitoringSourceWhere(instance),
		select: { id: true },
	})) !== null;

/** Publish valid observed ACK fields only; successful projection is required for204. */
async function publishObserved(
	app: FastifyInstance,
	instance: ServiceInstance,
	arrItemId: number,
	itemType: "movie" | "series" | "artist" | "author",
	acknowledged: Record<string, unknown>,
): Promise<boolean> {
	const seasons = itemType === "series" ? monitoringSeasons(acknowledged.seasons) : undefined;
	const monitored =
		typeof acknowledged.monitored === "boolean" ? acknowledged.monitored : undefined;
	if (monitored === undefined && seasons === undefined) return false;
	const where = {
		instanceId: instance.id,
		arrItemId,
		itemType,
		instance: monitoringSourceWhere(instance),
	};
	const cached = await app.prisma.libraryCache.findFirst({ where });
	if (!cached) return false;
	const data = JSON.parse(cached.data);
	if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
	if (monitored !== undefined) data.monitored = monitored;
	if (seasons !== undefined) {
		const previous = Array.isArray(data.seasons) ? data.seasons : [];
		const prior = (number: number) =>
			previous.find((season: { seasonNumber: number }) => season.seasonNumber === number);
		const observed = (
			normalizeSeasons(seasons.map((season) => ({ ...prior(season.seasonNumber), ...season }))) ??
			[]
		).map((season) => ({ ...prior(season.seasonNumber), ...season }));
		// ACK rows are positive observations, not complete-inventory/absence proof.
		data.seasons = previous.map(
			(season: { seasonNumber: number }) =>
				observed.find((row) => row.seasonNumber === season.seasonNumber) ?? season,
		);
		data.seasons.push(...observed.filter((season) => !prior(season.seasonNumber)));
		// This aggregate describes the merged cached view, not full provider coverage.
		data.statistics = {
			...data.statistics,
			monitoredSeasons: data.seasons.filter(
				(season: { monitored?: boolean }) => season.monitored === true,
			).length,
		};
	}
	// The UPDATE relation also fences a source change after the preceding SELECT.
	await app.prisma.libraryCache.update({
		where: { id: cached.id, ...where },
		data: {
			monitored: monitored ?? cached.monitored,
			data: JSON.stringify(data),
			updatedAt: new Date(),
		},
	});
	return true;
}

async function monitorChildren(
	app: FastifyInstance,
	request: FastifyRequest,
	reply: FastifyReply,
	input: { instanceId: string; parentId: number | string; ids: number[]; monitored: boolean },
	kind: "episode" | "album" | "book",
) {
	const parentId = Number(input.parentId);
	if (
		!isPositiveMonitoringId(parentId) ||
		input.ids.length === 0 ||
		!input.ids.every(isPositiveMonitoringId) ||
		new Set(input.ids).size !== input.ids.length
	)
		return reply.status(400).send({ error: "Invalid monitoring identifiers" });
	const result = await getClientForInstance(app, request, input.instanceId);
	if (!result.success) return reply.status(result.statusCode).send({ error: result.error });
	const { client, instance } = result;
	let read: () => Promise<unknown>,
		write: () => Promise<unknown>,
		key: "seriesId" | "artistId" | "authorId";
	if (kind === "episode" && isSonarrClient(client)) {
		key = "seriesId";
		read = () => client.episode.getAll({ episodeIds: input.ids });
		write = () => client.episode.setMonitored(input.ids, input.monitored);
	} else if (kind === "album" && isLidarrClient(client)) {
		key = "artistId";
		read = () => client.album.getAll({ albumIds: input.ids });
		write = () => client.album.monitor({ albumIds: input.ids, monitored: input.monitored });
	} else if (kind === "book" && isReadarrClient(client)) {
		key = "authorId";
		read = () => client.book.getAll({ bookIds: input.ids });
		write = () => client.book.monitor({ bookIds: input.ids, monitored: input.monitored });
	} else return reply.status(400).send({ error: "Unsupported monitoring service" });
	try {
		const parent = { key, id: parentId };
		if (
			!areRequestedMonitorRowsConfirmed(await read(), input.ids, parent) ||
			!(await sourceCurrent(app, instance))
		)
			return unconfirmed(reply);
		const acknowledged = await write();
		// Readarr void ACK requires one selected-ID GET, never another write/full scan.
		if (!(await sourceCurrent(app, instance))) return unconfirmed(reply);
		const observed = kind === "book" ? await read() : acknowledged;
		if (
			!(await sourceCurrent(app, instance)) ||
			!areRequestedMonitorRowsConfirmed(observed, input.ids, parent, input.monitored)
		)
			return unconfirmed(reply);
		return reply.status(204).send();
	} catch {
		request.log.warn("Monitoring update not confirmed");
		return unconfirmed(reply);
	}
}

export const registerMonitorRoutes: FastifyPluginCallback = (app, _opts, done) => {
	app.post("/library/monitor", async (request, reply) => {
		const payload = validateRequest(libraryToggleMonitorRequestSchema, request.body ?? {});
		const result = await getClientForInstance(app, request, payload.instanceId);
		if (!result.success) return reply.status(result.statusCode).send({ error: result.error });
		const { client, instance } = result;
		if (instance.service.toLowerCase() !== payload.service)
			return reply.status(400).send({ error: "Instance service mismatch" });
		const itemId = Number(payload.itemId);
		if (!isPositiveMonitoringId(itemId))
			return reply.status(400).send({ error: "Invalid item identifier" });
		const selected = payload.seasonNumbers;
		if (
			selected &&
			(!selected.every((number) => Number.isSafeInteger(number) && number >= 0) ||
				new Set(selected).size !== selected.length)
		)
			return reply.status(400).send({ error: "Invalid season selection" });
		try {
			let acknowledged: unknown, itemType: "movie" | "series" | "artist" | "author";
			let expectedSeasons: ReturnType<typeof monitoringSeasons>;
			if (isRadarrClient(client)) {
				const current = await client.movie.getById(itemId);
				if (
					!isMonitoringResourceForTarget(current, itemId) ||
					!(await sourceCurrent(app, instance))
				)
					return unconfirmed(reply);
				acknowledged = await client.movie.update(itemId, {
					...current,
					id: itemId,
					monitored: payload.monitored,
				});
				itemType = "movie";
			} else if (isSonarrClient(client)) {
				const current = await client.series.getById(itemId);
				if (!isMonitoringResourceForTarget(current, itemId)) return unconfirmed(reply);
				const seasons = monitoringSeasons(current.seasons);
				if (!seasons) return unconfirmed(reply);
				if (selected?.some((number) => !seasons.some((season) => season.seasonNumber === number)))
					return reply.status(400).send({ error: "Invalid season selection" });
				expectedSeasons = seasons.map((season) => ({
					...season,
					monitored: selected?.length
						? selected.includes(season.seasonNumber)
							? payload.monitored
							: season.monitored
						: season.seasonNumber === 0
							? false
							: payload.monitored,
				}));
				if (!(await sourceCurrent(app, instance))) return unconfirmed(reply);
				acknowledged = await client.series.update(itemId, {
					...current,
					id: itemId,
					monitored: payload.monitored,
					seasons: expectedSeasons,
				} as Parameters<typeof client.series.update>[1]);
				itemType = "series";
			} else if (isLidarrClient(client)) {
				const current = await client.artist.getById(itemId);
				if (
					!isMonitoringResourceForTarget(current, itemId) ||
					!(await sourceCurrent(app, instance))
				)
					return unconfirmed(reply);
				acknowledged = await client.artist.update(itemId, {
					...current,
					id: itemId,
					monitored: payload.monitored,
				});
				itemType = "artist";
			} else if (isReadarrClient(client)) {
				const current = await client.author.getById(itemId);
				if (
					!isMonitoringResourceForTarget(current, itemId) ||
					!(await sourceCurrent(app, instance))
				)
					return unconfirmed(reply);
				acknowledged = await client.author.update(itemId, {
					...current,
					id: itemId,
					monitored: payload.monitored,
				});
				itemType = "author";
			} else return reply.status(400).send({ error: "Unsupported service type" });
			if (
				!(await sourceCurrent(app, instance)) ||
				!isMonitoringResourceForTarget(acknowledged, itemId)
			)
				return unconfirmed(reply);
			const projected = await publishObserved(app, instance, itemId, itemType, acknowledged);
			if (
				!projected ||
				!isMonitoringStateConfirmed(acknowledged, {
					id: itemId,
					monitored: payload.monitored,
					seasons: expectedSeasons,
				})
			)
				return unconfirmed(reply);
			return reply.status(204).send();
		} catch {
			request.log.warn("Monitoring update not confirmed");
			return unconfirmed(reply);
		}
	});
	app.post("/library/episode/monitor", async (request, reply) => {
		const payload = validateRequest(libraryEpisodeMonitorRequestSchema, request.body ?? {});
		return monitorChildren(
			app,
			request,
			reply,
			{ ...payload, parentId: payload.seriesId, ids: payload.episodeIds },
			"episode",
		);
	});
	app.post("/library/album/monitor", async (request, reply) => {
		const payload = validateRequest(libraryAlbumMonitorRequestSchema, request.body ?? {});
		return monitorChildren(
			app,
			request,
			reply,
			{ ...payload, parentId: payload.artistId, ids: payload.albumIds },
			"album",
		);
	});
	app.post("/library/book/monitor", async (request, reply) => {
		const payload = validateRequest(libraryBookMonitorRequestSchema, request.body ?? {});
		return monitorChildren(
			app,
			request,
			reply,
			{ ...payload, parentId: payload.authorId, ids: payload.bookIds },
			"book",
		);
	});
	done();
};
