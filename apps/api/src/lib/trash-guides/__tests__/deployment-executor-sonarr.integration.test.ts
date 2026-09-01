import { randomUUID } from "node:crypto";
import { SonarrClient } from "arr-sdk";
import { describe, expect, it, vi } from "vitest";
import { DeploymentExecutorService } from "../deployment-executor.js";

// Reproducible fixture verified from local OCI metadata:
// lscr.io/linuxserver/sonarr:4.0.19.2979-ls322@sha256:c19aa4ecdf03d73e1d5c901da33744cb7eb4d921f89bafed1ca264601d7fa224
const sonarrUrl = process.env.SONARR_INTEGRATION_URL;
const sonarrApiKey = process.env.SONARR_INTEGRATION_API_KEY;
const hasLiveSonarr = Boolean(process.env.INTEGRATION_TESTS === "1" && sonarrUrl && sonarrApiKey);

async function resolveLiveSonarrCleanupTarget(
	client: Pick<SonarrClient, "customFormat">,
	createdId: number | undefined,
	syntheticName: string,
): Promise<{
	targetId: number;
	current: Awaited<ReturnType<SonarrClient["customFormat"]["getById"]>>;
}> {
	let targetId = createdId;
	if (targetId === undefined) {
		const namedCandidates = (await client.customFormat.getAll()).filter(
			(candidate) => candidate.name === syntheticName,
		);
		if (namedCandidates.length !== 1) {
			throw new Error(
				`Live Sonarr cleanup could not establish exactly one cleanup target named "${syntheticName}"; found ${namedCandidates.length}`,
			);
		}
		targetId = namedCandidates[0]?.id;
	}
	if (!Number.isSafeInteger(targetId) || (targetId ?? 0) <= 0) {
		throw new Error(
			`Live Sonarr cleanup target "${syntheticName}" has no exact positive resource ID`,
		);
	}
	return {
		targetId: targetId!,
		current: await client.customFormat.getById(targetId!),
	};
}

describe("live Sonarr cleanup target discovery", () => {
	it("recovers a unique full Custom Format by synthetic name when the POST ID is unknown", async () => {
		const listed = { id: 42, name: "Synthetic CF" };
		const complete = { ...listed, specifications: [] };
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([listed]),
				getById: vi.fn().mockResolvedValue(complete),
			},
		};

		await expect(
			resolveLiveSonarrCleanupTarget(client as never, undefined, "Synthetic CF"),
		).resolves.toEqual({ targetId: 42, current: complete });
		expect(client.customFormat.getById).toHaveBeenCalledWith(42);
	});

	it.each([
		["missing", []],
		[
			"ambiguous",
			[
				{ id: 42, name: "Synthetic CF" },
				{ id: 43, name: "Synthetic CF" },
			],
		],
	])("fails closed for a %s synthetic-name match", async (_case, listed) => {
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue(listed),
				getById: vi.fn(),
			},
		};

		await expect(
			resolveLiveSonarrCleanupTarget(client as never, undefined, "Synthetic CF"),
		).rejects.toThrow("could not establish exactly one cleanup target");
		expect(client.customFormat.getById).not.toHaveBeenCalled();
	});
});

describe.skipIf(!hasLiveSonarr)("DeploymentExecutorService with live Sonarr", () => {
	it("verifies create and update when Sonarr adds exceptLanguage=false", async () => {
		const client = new SonarrClient({
			baseUrl: sonarrUrl!,
			apiKey: sonarrApiKey!,
		});
		const executor = new DeploymentExecutorService({} as never, {} as never);
		const deployCustomFormats = (
			executor as unknown as {
				deployCustomFormats: (...args: unknown[]) => Promise<{
					created: number;
					updated: number;
				}>;
			}
		).deployCustomFormats.bind(executor);
		const runId = randomUUID();
		const syntheticName = `ARR Dashboard Sonarr post-write integration ${runId}`;
		const syntheticTrashId = `sonarr-except-language-integration-${runId}`;
		let createdId: number | undefined;
		const persistMutationState = vi.fn().mockResolvedValue(undefined);
		const createCustomFormat = client.customFormat.create.bind(client.customFormat);
		vi.spyOn(client.customFormat, "create").mockImplementation(async (format) => {
			const created = await createCustomFormat(format);
			if (!Number.isSafeInteger(created.id) || (created.id ?? 0) <= 0) {
				throw new Error("Live Sonarr test POST returned no exact positive resource ID");
			}
			if (createdId !== undefined && createdId !== created.id) {
				throw new Error("Live Sonarr test observed more than one created resource ID");
			}
			createdId = created.id;
			return created;
		});
		const specification = {
			name: "Language: Not English",
			implementation: "LanguageSpecification",
			negate: true,
			required: false,
			fields: [{ name: "value", value: 1 }],
		};
		let operationError: unknown;
		try {
			const systemStatus = await client.system.get();
			expect(systemStatus.version).toBe("4.0.19.2979");
			const createResult = await deployCustomFormats(
				client,
				[
					{
						trashId: syntheticTrashId,
						name: syntheticName,
						originalConfig: { specifications: [specification] },
					},
				],
				new Map(),
				new Map(),
				undefined,
				persistMutationState,
				"SONARR",
			);
			expect(createResult.created).toBe(1);
			expect(createdId).toEqual(expect.any(Number));

			const created = await client.customFormat.getById(createdId!);
			expect(created.name).toBe(syntheticName);
			const fields = created.specifications?.[0]?.fields;
			expect(fields).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: "value", value: 1 }),
					expect.objectContaining({ name: "exceptLanguage", value: false }),
				]),
			);

			const updateResult = await deployCustomFormats(
				client,
				[
					{
						trashId: syntheticTrashId,
						name: syntheticName,
						originalConfig: { specifications: [specification] },
					},
				],
				new Map([[syntheticTrashId, created]]),
				new Map([[syntheticName, created]]),
				undefined,
				persistMutationState,
				"SONARR",
			);
			expect(updateResult.updated).toBe(1);
		} catch (error) {
			operationError = error;
		}

		let cleanupError: unknown;
		try {
			const { targetId: cleanupTargetId, current } = await resolveLiveSonarrCleanupTarget(
				client,
				createdId,
				syntheticName,
			);
			const currentSpecification = current.specifications?.[0];
			const currentFields = currentSpecification?.fields?.map(({ name, value }) => ({
				name,
				value,
			}));
			if (
				current.id !== cleanupTargetId ||
				current.name !== syntheticName ||
				current.includeCustomFormatWhenRenaming !== false ||
				current.specifications?.length !== 1 ||
				currentSpecification?.name !== specification.name ||
				currentSpecification.implementation !== specification.implementation ||
				currentSpecification.negate !== specification.negate ||
				currentSpecification.required !== specification.required ||
				currentFields?.length !== 2 ||
				!currentFields.some((field) => field.name === "value" && field.value === 1) ||
				!currentFields.some((field) => field.name === "exceptLanguage" && field.value === false)
			) {
				cleanupError = new Error(
					`Refusing to clean up live Sonarr Custom Format "${syntheticName}" with exact ID ${cleanupTargetId} because its identity or contents changed`,
				);
			} else {
				await client.customFormat.delete(cleanupTargetId);
			}
		} catch (error) {
			cleanupError = error;
		}

		if (operationError !== undefined && cleanupError !== undefined) {
			throw new AggregateError(
				[operationError, cleanupError],
				"Live Sonarr verification and its scoped cleanup both failed",
			);
		}
		if (operationError !== undefined) throw operationError;
		if (cleanupError !== undefined) throw cleanupError;
	}, 30_000);
});
