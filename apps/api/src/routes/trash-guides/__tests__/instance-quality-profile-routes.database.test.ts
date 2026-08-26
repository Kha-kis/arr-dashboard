import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestPgClient, createTestPrismaClient } from "../../../lib/__tests__/test-prisma.js";
import type { PrismaClientInstance } from "../../../lib/prisma.js";
import { createDeploymentConnectionStateToken } from "../../../lib/trash-guides/deployment-target.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "../../__tests__/test-helpers.js";
import registerInstanceQualityProfileRoutes from "../instance-quality-profile-routes.js";

const databaseUrl = process.env.OVERRIDE_ROUTE_DATABASE_URL;
const runDatabaseTests =
	process.env.INTEGRATION_TESTS === "1" && databaseUrl ? describe : describe.skip;

const runId = randomUUID();
const ids = {
	user: `override-route-database-user-${runId}`,
	foreignUser: `override-route-database-foreign-user-${runId}`,
	primary: `override-route-database-primary-${runId}`,
	alias: `override-route-database-alias-${runId}`,
	otherCredential: `override-route-database-other-credential-${runId}`,
	otherEndpoint: `override-route-database-other-endpoint-${runId}`,
	foreignInstance: `override-route-database-foreign-instance-${runId}`,
};

const sharedConnection = {
	service: "SONARR" as const,
	baseUrl: "http://sonarr-override-route.test:8989",
	encryptedApiKey: "synthetic-encrypted-api-key",
	encryptionIv: "synthetic-encryption-iv",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
	connectionGeneration: 3,
};
const otherCredentialConnection = {
	...sharedConnection,
	encryptedApiKey: `synthetic-other-encrypted-api-key-${runId}`,
	encryptionIv: `synthetic-other-encryption-iv-${runId}`,
};

runDatabaseTests("instance quality-profile override route Prisma contract", () => {
	let app: FastifyInstance;
	let prisma: PrismaClientInstance;
	let cleanupDatabaseClient: (() => Promise<void>) | undefined;
	const createdUserIds: string[] = [];

	beforeAll(async () => {
		if (!databaseUrl) throw new Error("OVERRIDE_ROUTE_DATABASE_URL is required");
		if (/^postgres(ql)?:\/\//i.test(databaseUrl)) {
			const client = await createTestPgClient(databaseUrl);
			prisma = client.prisma;
			cleanupDatabaseClient = client.cleanup;
		} else {
			prisma = createTestPrismaClient(databaseUrl.replace(/^file:/, ""));
			cleanupDatabaseClient = () => prisma.$disconnect();
		}

		await prisma.user.create({ data: { id: ids.user, username: ids.user } });
		createdUserIds.push(ids.user);
		await prisma.user.create({
			data: { id: ids.foreignUser, username: ids.foreignUser },
		});
		createdUserIds.push(ids.foreignUser);
		await prisma.serviceInstance.createMany({
			data: [
				{
					id: ids.primary,
					userId: ids.user,
					label: "Primary Sonarr",
					...sharedConnection,
				},
				{
					id: ids.alias,
					userId: ids.user,
					label: "Alias Sonarr",
					...sharedConnection,
				},
				{
					id: ids.otherCredential,
					userId: ids.user,
					label: "Same endpoint with other credentials",
					...otherCredentialConnection,
				},
				{
					id: ids.otherEndpoint,
					userId: ids.user,
					label: "Other Sonarr endpoint",
					...sharedConnection,
					baseUrl: "http://other-sonarr-override-route.test:8989",
				},
				{
					id: ids.foreignInstance,
					userId: ids.foreignUser,
					label: "Foreign Sonarr",
					...sharedConnection,
				},
			],
		});

		const connectionStateToken = createDeploymentConnectionStateToken(sharedConnection);
		await prisma.instanceQualityProfileOverride.createMany({
			data: [
				{
					id: `override-route-database-primary-applied-${runId}`,
					instanceId: ids.primary,
					qualityProfileId: 4,
					customFormatId: 7,
					score: 100,
					status: "APPLIED",
					userId: ids.user,
					connectionGeneration: sharedConnection.connectionGeneration,
					connectionStateToken,
				},
				{
					id: `override-route-database-alias-applied-${runId}`,
					instanceId: ids.alias,
					qualityProfileId: 4,
					customFormatId: 7,
					score: 100,
					status: "APPLIED",
					userId: ids.user,
					connectionGeneration: sharedConnection.connectionGeneration,
					connectionStateToken,
				},
				{
					id: `override-route-database-alias-uncertain-${runId}`,
					instanceId: ids.alias,
					qualityProfileId: 4,
					customFormatId: 8,
					score: 25,
					status: "UNCERTAIN",
					intentOperation: "SET_SCORE",
					intendedScore: 25,
					userId: ids.user,
					connectionGeneration: sharedConnection.connectionGeneration,
					connectionStateToken,
				},
				{
					id: `override-route-database-other-credential-applied-${runId}`,
					instanceId: ids.otherCredential,
					qualityProfileId: 4,
					customFormatId: 11,
					score: 1_100,
					status: "APPLIED",
					userId: ids.user,
					connectionGeneration: otherCredentialConnection.connectionGeneration,
					connectionStateToken: createDeploymentConnectionStateToken(otherCredentialConnection),
				},
				{
					id: `override-route-database-other-credential-uncertain-${runId}`,
					instanceId: ids.otherCredential,
					qualityProfileId: 4,
					customFormatId: 12,
					score: 1_200,
					status: "UNCERTAIN",
					intentOperation: "SET_SCORE",
					intendedScore: 1_200,
					userId: ids.user,
					connectionGeneration: otherCredentialConnection.connectionGeneration,
					connectionStateToken: createDeploymentConnectionStateToken(otherCredentialConnection),
				},
				{
					id: `override-route-database-other-endpoint-${runId}`,
					instanceId: ids.otherEndpoint,
					qualityProfileId: 4,
					customFormatId: 9,
					score: 900,
					status: "APPLIED",
					userId: ids.user,
					connectionGeneration: sharedConnection.connectionGeneration,
					connectionStateToken: createDeploymentConnectionStateToken({
						...sharedConnection,
						baseUrl: "http://other-sonarr-override-route.test:8989",
					}),
				},
				{
					id: `override-route-database-foreign-user-${runId}`,
					instanceId: ids.foreignInstance,
					qualityProfileId: 4,
					customFormatId: 10,
					score: 1_000,
					status: "APPLIED",
					userId: ids.foreignUser,
					connectionGeneration: sharedConnection.connectionGeneration,
					connectionStateToken,
				},
			],
		});

		app = Fastify({ logger: false });
		setupAuthInjection(app, { id: ids.user, username: ids.user });
		registerTestErrorHandler(app);
		app.decorate("prisma", prisma);
		app.decorate("arrClientFactory", {
			createConnectionCredentialIdentity: vi.fn(
				(instance: typeof sharedConnection) =>
					`${instance.encryptedApiKey}:${instance.encryptionIv}`,
			),
		} as never);
		app.decorate("deploymentExecutor", {} as never);
		await app.register(registerInstanceQualityProfileRoutes, {
			prefix: "/api/trash-guides/instances",
		});
		await app.ready();
	});

	afterAll(async () => {
		await app?.close();
		if (prisma) {
			if (createdUserIds.length > 0) {
				await prisma.user.deleteMany({
					where: { id: { in: createdUserIds } },
				});
			}
			await cleanupDatabaseClient?.();
		}
	});

	it("returns alias-bound overrides and recovery without leaking users, endpoints, or secrets", async () => {
		const response = await createInjectAuthenticated(app)(
			"GET",
			`/api/trash-guides/instances/${ids.primary}/quality-profiles/4/overrides`,
		);

		expect(response.statusCode, response.body).toBe(200);
		const body = response.json();
		expect(body.overrides).toHaveLength(1);
		expect(body.overrides[0]).toMatchObject({
			customFormatId: 7,
			score: 100,
			status: "APPLIED",
			userId: ids.user,
		});
		expect(body.recoveryPlans).toMatchObject([
			{
				qualityProfileId: 4,
				retryable: true,
				requiresManualReconciliation: false,
				entries: [
					{
						customFormatId: 8,
						operation: "SET_SCORE",
						intendedScore: 25,
						status: "UNCERTAIN",
					},
				],
				retryAction: {
					method: "PATCH",
					recoveryToken: expect.stringMatching(/^[a-f0-9]{64}$/),
					scoreUpdates: [{ customFormatId: 8, score: 25 }],
				},
			},
		]);
		expect(response.body).not.toContain(ids.otherEndpoint);
		expect(response.body).not.toContain(ids.otherCredential);
		expect(response.body).not.toContain(ids.foreignInstance);
		expect(response.body).not.toContain(ids.foreignUser);
		expect(response.body).not.toContain(sharedConnection.encryptedApiKey);
		expect(response.body).not.toContain(sharedConnection.encryptionIv);
		expect(response.body).not.toContain(otherCredentialConnection.encryptedApiKey);
		expect(response.body).not.toContain(otherCredentialConnection.encryptionIv);
		expect(body.overrides).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ customFormatId: 11 })]),
		);
		expect(body.recoveryPlans).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					entries: expect.arrayContaining([expect.objectContaining({ customFormatId: 12 })]),
				}),
			]),
		);
	});
});
