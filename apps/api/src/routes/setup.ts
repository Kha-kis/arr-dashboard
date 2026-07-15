import {
	type ApplySetupStartersResponse,
	applySetupStartersRequestSchema,
	type SetupDiscoveryResponse,
	type SetupStarterDefinition,
	type SetupStarterId,
} from "@arr/shared";
import type { FastifyInstance, FastifyPluginCallback } from "fastify";
import { discoverMediaServers } from "../lib/setup-discovery/udp-discovery.js";
import { validateRequest } from "../lib/utils/validate.js";

let activeDiscovery: Promise<SetupDiscoveryResponse> | null = null;
const DISCOVERY_RATE_LIMIT = { max: 5, timeWindow: "1 minute" };

const STARTER_NAMES: Record<SetupStarterId, string> = {
	"notification-throttle": "Starter: throttle repeated hunt matches",
	"auto-tag-recent": "Starter: tag recently added media",
	"label-sync-recent": "Starter: sync recently added label",
};

type StarterService = NonNullable<SetupStarterDefinition["source"]>;

const toStarterService = (service: {
	id: string;
	service: string;
	label: string;
}): StarterService => ({
	id: service.id,
	service: service.service.toLowerCase() as StarterService["service"],
	label: service.label,
});

async function getStarterCatalog(
	app: FastifyInstance,
	userId: string,
): Promise<SetupStarterDefinition[]> {
	const [services, notificationRule, autoTagRule, labelSyncRule] = await Promise.all([
		app.prisma.serviceInstance.findMany({
			where: {
				userId,
				enabled: true,
				service: { in: ["SONARR", "RADARR", "PLEX", "JELLYFIN", "EMBY"] },
			},
			select: { id: true, service: true, label: true, isDefault: true, createdAt: true },
			orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
		}),
		app.prisma.notificationRule.findFirst({
			where: { userId, name: STARTER_NAMES["notification-throttle"] },
			select: { id: true },
		}),
		app.prisma.autoTagRule.findFirst({
			where: { userId, name: STARTER_NAMES["auto-tag-recent"] },
			select: { id: true },
		}),
		app.prisma.labelSyncRule.findFirst({
			where: { userId, name: STARTER_NAMES["label-sync-recent"] },
			select: { id: true },
		}),
	]);

	const sourceRow = services.find(
		(service) => service.service === "SONARR" || service.service === "RADARR",
	);
	const destinationRow = services.find(
		(service) =>
			service.service === "PLEX" || service.service === "JELLYFIN" || service.service === "EMBY",
	);
	const source = sourceRow ? toStarterService(sourceRow) : null;
	const destination = destinationRow ? toStarterService(destinationRow) : null;

	return [
		{
			id: "notification-throttle",
			kind: "notifications",
			title: "Throttle repeated hunt matches",
			description: "A starting point for grouping repeated content-found notifications.",
			effect:
				"Creates a disabled 30-minute throttle rule. It sends nothing until you review and enable it.",
			available: true,
			unavailableReason: null,
			existing: Boolean(notificationRule),
			source: null,
			destination: null,
		},
		{
			id: "auto-tag-recent",
			kind: "auto-tag",
			title: "Tag recently added media",
			description: "A reusable draft for media added to Sonarr or Radarr in the last 30 days.",
			effect:
				"Creates a disabled rule that would apply the arr-dashboard-recent tag after you enable it.",
			available: Boolean(source),
			unavailableReason: source ? null : "Connect Sonarr or Radarr to use this starter.",
			existing: Boolean(autoTagRule),
			source,
			destination: null,
		},
		{
			id: "label-sync-recent",
			kind: "label-sync",
			title: "Sync the recently added label",
			description: "A draft bridge from an *arr tag to your primary media server.",
			effect:
				"Creates a disabled mapping for arr-dashboard-recent. No labels are written until you enable it.",
			available: Boolean(source && destination),
			unavailableReason:
				source && destination
					? null
					: "Connect Sonarr or Radarr plus Plex, Jellyfin, or Emby to use this starter.",
			existing: Boolean(labelSyncRule),
			source,
			destination,
		},
	];
}

export const registerSetupRoutes: FastifyPluginCallback = (app, _opts, done) => {
	app.post("/setup/discovery", { config: { rateLimit: DISCOVERY_RATE_LIMIT } }, async (request) => {
		if (!activeDiscovery) {
			activeDiscovery = discoverMediaServers({ log: request.log }).finally(() => {
				activeDiscovery = null;
			});
		}
		return activeDiscovery;
	});

	app.get("/setup/starters", async (request) => {
		const userId = request.currentUser!.id;
		return { starters: await getStarterCatalog(app, userId) };
	});

	app.post("/setup/starters", async (request, reply) => {
		const userId = request.currentUser!.id;
		const body = validateRequest(applySetupStartersRequestSchema, request.body);
		const catalog = await getStarterCatalog(app, userId);
		const definitions = new Map(catalog.map((starter) => [starter.id, starter]));
		const selected = body.starterIds.map((id) => definitions.get(id)!);
		const unavailable = selected.find((starter) => !starter.available);
		if (unavailable) {
			return reply.status(400).send({
				error: "Starter unavailable",
				message: unavailable.unavailableReason,
			});
		}

		const existing = selected.filter((starter) => starter.existing).map((starter) => starter.id);
		const pending = selected.filter((starter) => !starter.existing);
		const operations = pending.map((starter) => {
			if (starter.id === "notification-throttle") {
				return app.prisma.notificationRule.create({
					data: {
						userId,
						name: STARTER_NAMES[starter.id],
						enabled: false,
						priority: 100,
						action: "throttle",
						conditions: JSON.stringify([
							{ field: "eventType", operator: "equals", value: "HUNT_CONTENT_FOUND" },
						]),
						throttleMinutes: 30,
					},
				});
			}
			if (starter.id === "auto-tag-recent") {
				return app.prisma.autoTagRule.create({
					data: {
						userId,
						name: STARTER_NAMES[starter.id],
						enabled: false,
						ruleType: "age",
						parameters: JSON.stringify({ field: "arrAddedAt", operator: "newer_than", days: 30 }),
						serviceFilter: JSON.stringify([starter.source!.service]),
						instanceFilter: JSON.stringify([starter.source!.id]),
						tagName: "arr-dashboard-recent",
					},
				});
			}
			return app.prisma.labelSyncRule.create({
				data: {
					userId,
					name: STARTER_NAMES[starter.id],
					enabled: false,
					sourceService: starter.source!.service,
					sourceInstanceId: starter.source!.id,
					sourceTagName: "arr-dashboard-recent",
					destService: starter.destination!.service,
					destInstanceId: starter.destination!.id,
					destTagName: "arr-dashboard-recent",
				},
			});
		});

		if (operations.length > 0) await app.prisma.$transaction(operations);
		const response: ApplySetupStartersResponse = {
			created: pending.map((starter) => starter.id),
			existing,
		};
		request.log.info({ userId, created: response.created }, "Applied disabled Setup starter rules");
		return reply.status(201).send(response);
	});

	done();
};
