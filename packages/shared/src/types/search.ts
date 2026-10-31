import { z } from "zod";

export const searchTypeSchema = z.enum(["all", "movie", "tv", "music", "book"]);

export const searchProtocolSchema = z.enum(["torrent", "usenet", "unknown"]);

/** Lightweight health summary attached to each indexer in list responses */
export const prowlarrIndexerHealthSchema = z.object({
	successRate: z.number().optional(),
	averageResponseTime: z.number().optional(),
	grabs: z.number().optional(),
	fails: z.number().optional(),
	lastCheck: z.string().optional(),
	lastFailure: z.string().optional(),
});

export type ProwlarrIndexerHealth = z.infer<typeof prowlarrIndexerHealthSchema>;

export const prowlarrIndexerSchema = z.object({
	id: z.number().int().nonnegative(),
	name: z.string(),
	enable: z.boolean(),
	protocol: searchProtocolSchema,
	supportsRss: z.boolean().optional(),
	supportsSearch: z.boolean().optional(),
	supportsRedirect: z.boolean().optional(),
	appProfileId: z.number().int().nonnegative().optional(),
	priority: z.number().int().optional(),
	tags: z.array(z.number().int()).optional(),
	capabilities: z.array(z.string()).optional(),
	instanceId: z.string(),
	instanceName: z.string(),
	instanceUrl: z.string().optional(),
	health: prowlarrIndexerHealthSchema.optional(),
});

export type ProwlarrIndexer = z.infer<typeof prowlarrIndexerSchema>;

export const prowlarrIndexerFieldSelectOptionSchema = z.object({
	value: z.union([z.string(), z.number()]),
	name: z.string(),
	hint: z.string().optional(),
});

export type ProwlarrIndexerFieldSelectOption = z.infer<
	typeof prowlarrIndexerFieldSelectOptionSchema
>;

export const prowlarrIndexerFieldSchema = z.object({
	name: z.string(),
	label: z.string().optional(),
	helpText: z.string().optional(),
	value: z.union([z.string(), z.number(), z.boolean()]).nullable().optional(),
	type: z.string().optional(),
	selectOptions: z.array(prowlarrIndexerFieldSelectOptionSchema).optional(),
});

export type ProwlarrIndexerField = z.infer<typeof prowlarrIndexerFieldSchema>;

const SENSITIVE_INDEXER_FIELD_NAMES = new Set([
	"mamid",
	"pid",
	"rsskey",
	"uid",
	"userid",
	"userpasskey",
]);
const SENSITIVE_INDEXER_FIELD_PATTERNS = [
	"apikey",
	"api_key",
	"passkey",
	"cookie",
	"password",
	"secret",
	"token",
] as const;

/** Shared edit/display policy for provider-owned indexer fields. */
export const isSensitiveProwlarrField = (
	field: Pick<ProwlarrIndexerField, "name" | "label" | "type">,
): boolean => {
	const name = field.name.toLowerCase();
	const label = (field.label ?? "").toLowerCase();
	const type = (field.type ?? "").toLowerCase();
	if (type === "password" || type === "hidden") return true;
	if (SENSITIVE_INDEXER_FIELD_NAMES.has(name)) return true;
	if (
		SENSITIVE_INDEXER_FIELD_PATTERNS.some(
			(pattern) => name.includes(pattern) || label.includes(pattern),
		)
	)
		return true;
	return (
		(name.includes("about") && name.includes("api")) ||
		(label.includes("about") && label.includes("api"))
	);
};

export const prowlarrIndexerStatsSchema = z.object({
	status: z.string().optional(),
	message: z.string().optional(),
	successRate: z.number().optional(),
	averageResponseTime: z.number().optional(),
	responseTime: z.number().optional(),
	grabs: z.number().optional(),
	fails: z.number().optional(),
	lastCheck: z.string().optional(),
	lastFailure: z.string().optional(),
});

export type ProwlarrIndexerStats = z.infer<typeof prowlarrIndexerStatsSchema>;

export const prowlarrIndexerDetailsSchema = z.object({
	id: z.number().int().nonnegative(),
	name: z.string(),
	enable: z.boolean().optional(),
	protocol: searchProtocolSchema.optional(),
	priority: z.number().int().optional(),
	appProfileId: z.number().int().optional(),
	instanceId: z.string(),
	instanceName: z.string(),
	instanceUrl: z.string().optional(),
	implementationName: z.string().optional(),
	definitionName: z.string().optional(),
	description: z.string().optional(),
	language: z.string().optional(),
	privacy: z.string().optional(),
	isPrivate: z.boolean().optional(),
	capabilities: z.array(z.string()).optional(),
	tags: z.array(z.number().int()).optional(),
	categories: z.array(z.number().int()).optional(),
	fields: z.array(prowlarrIndexerFieldSchema).optional(),
	stats: prowlarrIndexerStatsSchema.optional(),
});

export type ProwlarrIndexerDetails = z.infer<typeof prowlarrIndexerDetailsSchema>;

export const searchIndexerDetailsResponseSchema = z.object({
	indexer: prowlarrIndexerDetailsSchema,
});

export type SearchIndexerDetailsResponse = z.infer<typeof searchIndexerDetailsResponseSchema>;

export const searchIndexersResponseSchema = z.object({
	instances: z.array(
		z.object({
			instanceId: z.string(),
			instanceName: z.string(),
			success: z.boolean(),
			data: z.array(prowlarrIndexerSchema),
		}),
	),
	aggregated: z.array(prowlarrIndexerSchema),
	totalCount: z.number().int().nonnegative(),
	failedInstanceCount: z.number().int().nonnegative(),
});

export type SearchIndexersResponse = z.infer<typeof searchIndexersResponseSchema>;

const searchLanguageSchema = z.object({
	id: z.number().int(),
	name: z.string(),
});

export const searchResultSchema = z.object({
	id: z.string(),
	guid: z.string().optional(),
	/** Opaque result provenance; display fields never confer Grab authority. */
	grabSelector: z
		.string()
		.max(16_384)
		.regex(/^sg1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/)
		.optional(),
	title: z.string(),
	size: z.number().nonnegative().optional(),
	link: z.string().optional(),
	magnetUrl: z.string().optional(),
	infoUrl: z.string().optional(),
	downloadUrl: z.string().optional(),
	indexer: z.string(),
	indexerId: z.number().int().nonnegative(),
	categories: z.array(z.number().int()).optional(),
	seeders: z.number().nonnegative().optional(),
	leechers: z.number().nonnegative().optional(),
	peers: z.number().nonnegative().optional(),
	grabs: z.number().nonnegative().optional(),
	protocol: searchProtocolSchema,
	publishDate: z.string().optional(),
	age: z.number().nonnegative().optional(),
	ageHours: z.number().nonnegative().optional(),
	ageDays: z.number().nonnegative().optional(),
	downloadClient: z.string().optional(),
	downloadVolumeFactor: z.number().nonnegative().optional(),
	uploadVolumeFactor: z.number().nonnegative().optional(),
	minimumRatio: z.number().nonnegative().optional(),
	minimumSeedTime: z.number().nonnegative().optional(),
	rejectionReasons: z.array(z.string()).optional(),
	rejected: z.boolean().optional(),
	languages: z.array(searchLanguageSchema).optional(),
	quality: z.unknown().optional(),
	metadataIncomplete: z.boolean().optional(),
	instanceId: z.string(),
	instanceName: z.string(),
	instanceUrl: z.string().optional(),
});

export type SearchResult = z.infer<typeof searchResultSchema>;

/** Counts describe only the batch returned by successful provider reads. */
export const searchCoverageSchema = z
	.object({
		receivedCount: z.number().int().nonnegative(),
		acceptedCount: z.number().int().nonnegative(),
		rejectedCount: z.number().int().nonnegative(),
		metadataIncompleteCount: z.number().int().nonnegative(),
	})
	.refine(
		(coverage) =>
			coverage.receivedCount === coverage.acceptedCount + coverage.rejectedCount &&
			coverage.metadataIncompleteCount <= coverage.acceptedCount,
		{ message: "Invalid returned-batch coverage" },
	);

export type SearchCoverage = z.infer<typeof searchCoverageSchema>;

export const multiInstanceSearchResponseSchema = z
	.object({
		instances: z.array(
			z.object({
				instanceId: z.string(),
				instanceName: z.string(),
				success: z.boolean(),
				data: z.array(searchResultSchema),
				coverage: searchCoverageSchema.optional(),
			}),
		),
		aggregated: z.array(searchResultSchema),
		totalCount: z.number().int().nonnegative(),
		failedInstanceCount: z.number().int().nonnegative(),
		coverage: searchCoverageSchema.optional(),
	})
	.superRefine((response, ctx) => {
		const invalid = () => ctx.addIssue({ code: "custom", message: "Inconsistent search response" });
		const successful = response.instances.filter((instance) => instance.success);
		const rows = successful.flatMap((instance) => instance.data);
		if (
			response.totalCount !== response.aggregated.length ||
			rows.length !== response.totalCount ||
			response.failedInstanceCount < response.instances.length - successful.length ||
			new Set(response.instances.map((instance) => instance.instanceId)).size !==
				response.instances.length
		)
			invalid();
		for (const instance of response.instances) {
			if (
				instance.data.some((row) => row.instanceId !== instance.instanceId) ||
				(!instance.success && (instance.data.length > 0 || instance.coverage !== undefined))
			)
				invalid();
			if (
				instance.coverage &&
				(instance.coverage.acceptedCount !== instance.data.length ||
					instance.coverage.metadataIncompleteCount !==
						instance.data.filter((row) => row.metadataIncomplete === true).length)
			)
				invalid();
		}
		// Compare the accepted row multiset as well as counts; ordering is not authority.
		const serializedRows = rows.map((row) => JSON.stringify(row)).sort();
		const serializedAggregated = response.aggregated.map((row) => JSON.stringify(row)).sort();
		if (serializedRows.some((row, index) => row !== serializedAggregated[index])) invalid();
		if (response.coverage) {
			if (successful.length === 0 || successful.some((instance) => !instance.coverage)) invalid();
			for (const key of [
				"receivedCount",
				"acceptedCount",
				"rejectedCount",
				"metadataIncompleteCount",
			] as const) {
				if (
					response.coverage[key] !==
					successful.reduce((total, instance) => total + (instance.coverage?.[key] ?? 0), 0)
				)
					invalid();
			}
		}
	});

export type MultiInstanceSearchResponse = z.infer<typeof multiInstanceSearchResponseSchema>;

const searchFilterSchema = z.object({
	instanceId: z.string(),
	indexerIds: z.array(z.number().int().positive()).optional(),
	categories: z.array(z.number().int().positive()).optional(),
});

export const searchRequestSchema = z.object({
	query: z.string().min(1).max(200),
	type: searchTypeSchema.default("all"),
	limit: z.number().int().min(1).max(200).optional(),
	filters: z.array(searchFilterSchema).optional(),
});

export type SearchRequest = z.infer<typeof searchRequestSchema>;

/** Shape and size admission only; the API authenticates selector contents before dispatch. */
export const searchGrabRequestSchema = z.strictObject({
	instanceId: z.string().min(1).max(128),
	intentId: z.string().uuid(),
	selector: z
		.string()
		.max(16_384)
		.regex(/^sg1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{23,}$/),
	retry: z
		.strictObject({ predecessorId: z.string().uuid(), duplicateRiskConfirmed: z.literal(true) })
		.optional(),
});

export type SearchGrabRequest = z.infer<typeof searchGrabRequestSchema>;

export const searchGrabStateSchema = z.enum([
	"prepared",
	"submitting",
	"acknowledged",
	"rejected",
	"uncertain",
]);
export const searchGrabStatusSchema = z
	.strictObject({
		attemptId: z.string().uuid(),
		intentId: z.string().uuid(),
		state: searchGrabStateSchema,
		requestedAt: z.string().datetime(),
		dispatchedAt: z.string().datetime().nullable(),
		completedAt: z.string().datetime().nullable(),
		outcomeCategory: z
			.enum([
				"transport-unconfirmed",
				"provider-rejected",
				"interrupted-before-dispatch",
				"interrupted-after-marker",
				"predecessor-acknowledged",
			])
			.nullable(),
		nextAction: z.enum(["none", "new-search", "inspect-before-confirmed-retry", "observe-status"]),
	})
	.superRefine((status, context) => {
		const expected =
			status.state === "acknowledged"
				? "none"
				: status.state === "rejected"
					? "new-search"
					: status.state === "uncertain"
						? "inspect-before-confirmed-retry"
						: "observe-status";
		const invalid = () =>
			context.addIssue({ code: "custom", message: "Invalid submission status contract" });
		if (status.nextAction !== expected) invalid();
		if (
			status.state === "prepared" &&
			(status.dispatchedAt !== null || status.completedAt !== null)
		)
			invalid();
		if (
			["submitting", "uncertain", "acknowledged"].includes(status.state) &&
			status.dispatchedAt === null
		)
			invalid();
		if (status.state === "submitting" && status.completedAt !== null) invalid();
		if (["acknowledged", "rejected"].includes(status.state) && status.completedAt === null)
			invalid();
		if (status.state === "acknowledged" && status.outcomeCategory !== null) invalid();
		const requested = Date.parse(status.requestedAt),
			dispatched = status.dispatchedAt ? Date.parse(status.dispatchedAt) : null,
			completed = status.completedAt ? Date.parse(status.completedAt) : null;
		if (
			(dispatched !== null && dispatched < requested) ||
			(completed !== null && completed < (dispatched ?? requested))
		)
			invalid();
	});
export type SearchGrabStatus = z.infer<typeof searchGrabStatusSchema>;

/** Read-only body: selectors must never be placed in URL query strings. */
export const searchGrabResultStatusRequestSchema = z.strictObject({
	results: z
		.array(
			z.strictObject({
				instanceId: searchGrabRequestSchema.shape.instanceId,
				selector: searchGrabRequestSchema.shape.selector,
			}),
		)
		.min(1)
		.max(50),
});
export type SearchGrabResultStatusRequest = z.infer<typeof searchGrabResultStatusRequestSchema>;

const resultIndexSchema = z.number().int().min(0).max(49);
export const searchGrabResultStatusResponseSchema = z
	.strictObject({
		results: z
			.array(
				z.discriminatedUnion("availability", [
					z.strictObject({
						resultIndex: resultIndexSchema,
						availability: z.literal("recorded"),
						status: searchGrabStatusSchema,
					}),
					z.strictObject({
						resultIndex: resultIndexSchema,
						availability: z.literal("not-recorded"),
						status: z.null(),
					}),
					z.strictObject({
						resultIndex: resultIndexSchema,
						availability: z.literal("unavailable"),
						status: z.null(),
					}),
				]),
			)
			.min(1)
			.max(50),
	})
	.superRefine((response, context) => {
		if (response.results.some((result, index) => result.resultIndex !== index))
			context.addIssue({ code: "custom", message: "Invalid result status correlation" });
	});
export type SearchGrabResultStatusResponse = z.infer<typeof searchGrabResultStatusResponseSchema>;

export const searchIndexerTestRequestSchema = z.object({
	instanceId: z.string(),
	indexerId: z.number().int().positive(),
});

export type SearchIndexerTestRequest = z.infer<typeof searchIndexerTestRequestSchema>;

export const searchIndexerTestResponseSchema = z.object({
	success: z.boolean(),
	message: z.string().optional(),
});

export type SearchIndexerTestResponse = z.infer<typeof searchIndexerTestResponseSchema>;

export const searchIndexerUpdateChangesSchema = z
	.strictObject({
		enable: z.boolean().optional(),
		priority: z.number().int().optional(),
		fields: z
			.array(
				z.strictObject({
					name: z.string().min(1),
					value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
				}),
			)
			.max(100)
			.optional(),
	})
	.refine(
		(value) =>
			value.enable !== undefined || value.priority !== undefined || (value.fields?.length ?? 0) > 0,
		{ message: "At least one indexer change is required" },
	);

export type SearchIndexerUpdateChanges = z.infer<typeof searchIndexerUpdateChangesSchema>;

export const searchIndexerUpdateRequestSchema = z.strictObject({
	changes: searchIndexerUpdateChangesSchema,
});

export type SearchIndexerUpdateRequest = z.infer<typeof searchIndexerUpdateRequestSchema>;

export const searchIndexerUpdateOutcomeSchema = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("verified"), indexer: prowlarrIndexerDetailsSchema }),
	z.strictObject({ status: z.literal("applied-unverified") }),
	z.strictObject({ status: z.literal("outcome-unknown") }),
]);

export type SearchIndexerUpdateOutcome = z.infer<typeof searchIndexerUpdateOutcomeSchema>;
