import {
	type SearchGrabRequest,
	type SearchGrabResultStatusRequest,
	type SearchGrabResultStatusResponse,
	type SearchGrabStatus,
	searchGrabRequestSchema,
	searchGrabResultStatusRequestSchema,
	searchGrabResultStatusResponseSchema,
	searchGrabStateSchema,
	searchGrabStatusSchema,
} from "@arr/shared";
import { ArrError } from "arr-sdk";
import { z } from "zod";
import type { ArrClientFactory } from "../arr/client-factory.js";
import { createArrServiceFingerprint } from "../arr/service-fingerprint.js";
import type { Encryptor } from "../auth/encryption.js";
import {
	assertRestoreRuntimeOperation,
	getRestoreRuntimeClientContext,
	type RestoreRuntime,
} from "../backup/restore-runtime-admission.js";
import type { PrismaClientInstance, SearchGrabAttempt } from "../prisma.js";
import {
	createSearchGrabRepository,
	type SearchGrabOutcome,
	SearchGrabRepositoryError,
} from "./grab-repository.js";
import {
	assertSearchGrabSelectorMatchesRecordedTarget,
	readSearchGrabSelector,
	type SearchGrabTarget,
	searchGrabTargetSchema,
} from "./grab-selector.js";
import { grabVerifiedProwlarrTargetWithSdk } from "./prowlarr-api.js";

const storedTargetSchema = z
	.object({
		purpose: z.literal("arr-dashboard:search-grab-target"),
		version: z.literal(1),
		guid: searchGrabTargetSchema.shape.guid,
		indexerId: searchGrabTargetSchema.shape.indexerId,
	})
	.strict();
export type SearchGrabSubmission = SearchGrabRequest;
export type { SearchGrabStatus } from "@arr/shared";

export class SearchGrabServiceError extends Error {
	readonly statusCode = 502;
	constructor() {
		super(
			"Submission status could not be established. Inspect its recorded status before retrying.",
		);
		this.name = "SearchGrabServiceError";
	}
}

function safeStatus(attempt: SearchGrabAttempt): SearchGrabStatus {
	try {
		const state = searchGrabStateSchema.parse(attempt.state);
		return searchGrabStatusSchema.parse({
			attemptId: attempt.id,
			intentId: attempt.intentId,
			state,
			requestedAt: attempt.requestedAt.toISOString(),
			dispatchedAt: attempt.dispatchedAt?.toISOString() ?? null,
			completedAt: attempt.completedAt?.toISOString() ?? null,
			outcomeCategory: attempt.outcomeCategory,
			nextAction:
				state === "acknowledged"
					? "none"
					: state === "rejected"
						? "new-search"
						: state === "uncertain"
							? "inspect-before-confirmed-retry"
							: "observe-status",
		});
	} catch {
		throw new SearchGrabServiceError();
	}
}

/** Keep this promise within the actual lifecycle/runtime handler, never a response-timeout race. */
export function createSearchGrabService(options: {
	prisma: PrismaClientInstance;
	runtime: RestoreRuntime;
	encryptor: Encryptor;
	arrClientFactory: ArrClientFactory;
	userId: string;
	now?: () => number;
}) {
	const { prisma, runtime, encryptor, arrClientFactory, userId } = options;
	const now = options.now ?? Date.now;
	const repository = createSearchGrabRepository(prisma, runtime, encryptor, userId);
	const epoch = getRestoreRuntimeClientContext(runtime).runtimeEpoch;
	const binding = (attempt: SearchGrabAttempt) => ({
		userId,
		serviceInstanceId: attempt.serviceInstanceId,
		connectionFingerprint: attempt.connectionFingerprint,
	});
	async function status(intentId: string): Promise<SearchGrabStatus | null> {
		if (!z.string().uuid().safeParse(intentId).success)
			throw new SearchGrabRepositoryError("intent-conflict");
		await assertRestoreRuntimeOperation(runtime);
		const attempt = await repository.findByIntent(intentId);
		await assertRestoreRuntimeOperation(runtime);
		return attempt ? safeStatus(attempt) : null;
	}
	async function resultStatuses(
		value: SearchGrabResultStatusRequest,
	): Promise<SearchGrabResultStatusResponse> {
		const input = searchGrabResultStatusRequestSchema.safeParse(value);
		if (!input.success) throw new SearchGrabServiceError();
		await assertRestoreRuntimeOperation(runtime);
		const results: SearchGrabResultStatusResponse["results"] = [];
		for (const [resultIndex, entry] of input.data.results.entries()) {
			const unavailable = { resultIndex, availability: "unavailable" as const, status: null };
			const instance = await prisma.serviceInstance.findFirst({
				where: { userId, id: entry.instanceId, service: "PROWLARR" },
			});
			if (!instance) {
				results.push(unavailable);
				continue;
			}
			let target: SearchGrabTarget;
			try {
				target = readSearchGrabSelector(
					encryptor,
					entry.selector,
					{
						userId,
						serviceInstanceId: instance.id,
						connectionFingerprint: createArrServiceFingerprint(instance),
					},
					now(),
				);
			} catch {
				results.push(unavailable);
				continue;
			}
			try {
				const attempt = await repository.findForTarget(target);
				results.push(
					attempt
						? { resultIndex, availability: "recorded", status: safeStatus(attempt) }
						: { resultIndex, availability: "not-recorded", status: null },
				);
			} catch (error) {
				if (
					error instanceof SearchGrabRepositoryError &&
					error.category === "connection-unavailable"
				)
					results.push(unavailable);
				else throw new SearchGrabServiceError();
			}
		}
		await assertRestoreRuntimeOperation(runtime);
		return searchGrabResultStatusResponseSchema.parse({ results });
	}
	async function submit(value: SearchGrabSubmission): Promise<SearchGrabStatus> {
		const parsed = searchGrabRequestSchema.safeParse(value);
		if (!parsed.success) throw new SearchGrabRepositoryError("intent-conflict");
		const input = parsed.data;
		await repository.recoverPreviousRuntime();
		const existing = await repository.findByIntent(input.intentId);
		if (existing) {
			if (input.instanceId !== existing.serviceInstanceId)
				throw new SearchGrabRepositoryError("intent-conflict");
			let target: SearchGrabTarget;
			try {
				const stored = storedTargetSchema.parse(
					JSON.parse(encryptor.decrypt({ value: existing.encryptedTarget, iv: existing.targetIv })),
				);
				target = searchGrabTargetSchema.parse({
					...binding(existing),
					guid: stored.guid,
					indexerId: stored.indexerId,
				});
				assertSearchGrabSelectorMatchesRecordedTarget(encryptor, input.selector, target, now());
			} catch {
				throw new SearchGrabRepositoryError("intent-conflict");
			}
			return safeStatus(
				await repository.observe({ intentId: input.intentId, target, retry: input.retry }),
			);
		}
		const instance = await prisma.serviceInstance.findFirst({
			where: { userId, id: input.instanceId, enabled: true, service: "PROWLARR" },
		});
		if (!instance) throw new SearchGrabRepositoryError("connection-unavailable");
		let target: SearchGrabTarget;
		try {
			target = readSearchGrabSelector(
				encryptor,
				input.selector,
				{
					userId,
					serviceInstanceId: instance.id,
					connectionFingerprint: createArrServiceFingerprint(instance),
				},
				now(),
			);
		} catch {
			throw new SearchGrabRepositoryError("connection-unavailable");
		}
		let attemptId: string | undefined;
		const createClient = () =>
			arrClientFactory.createProwlarrClient(instance, {
				onRequest: async ({ url, method }) => {
					// The installed SDK awaits this hook immediately before its one fetch.
					if (
						!attemptId ||
						method !== "POST" ||
						url.href !== new URL(`${instance.baseUrl.replace(/\/$/, "")}/api/v1/search`).href
					)
						throw new SearchGrabRepositoryError("attempt-unavailable");
					await assertRestoreRuntimeOperation(runtime);
					const attempt = await prisma.searchGrabAttempt.findFirst({
						where: {
							userId,
							id: attemptId,
							state: "submitting",
							workerEpoch: epoch,
							dispatchedAt: { not: null },
						},
					});
					const current = await prisma.serviceInstance.findFirst({
						where: { userId, id: instance.id, enabled: true, service: "PROWLARR" },
					});
					if (
						!attempt ||
						!current ||
						createArrServiceFingerprint(current) !== target.connectionFingerprint ||
						!(await prisma.searchGrabClaim.findFirst({
							where: {
								userId,
								serviceInstanceId: instance.id,
								targetHash: attempt.targetHash,
								attemptId,
							},
						}))
					)
						throw new SearchGrabRepositoryError("attempt-unavailable");
					if (attempt.predecessorId) {
						const previous = await prisma.searchGrabAttempt.findFirst({
							where: { userId, id: attempt.predecessorId },
						});
						if (previous?.state !== "uncertain")
							throw new SearchGrabRepositoryError("retry-invalid");
					}
					await assertRestoreRuntimeOperation(runtime);
				},
			});
		let client: ReturnType<ArrClientFactory["createProwlarrClient"]>;
		try {
			client = createClient();
		} catch {
			throw new SearchGrabRepositoryError("connection-unavailable");
		}
		const admission = await repository.admit({
			intentId: input.intentId,
			target,
			retry: input.retry,
		});
		if (!admission.created) return safeStatus(admission.attempt);
		let dispatch: Awaited<ReturnType<typeof repository.claimDispatch>>;
		try {
			dispatch = await repository.claimDispatch(admission.attempt.id);
		} catch {
			// Do not infer rollback from the exception: native state must prove no marker exists.
			try {
				return safeStatus(await repository.rejectUnsent(admission.attempt.id));
			} catch {
				throw new SearchGrabServiceError();
			}
		}
		if (!dispatch.admitted) return safeStatus(dispatch.attempt);
		attemptId = dispatch.attempt.id;
		let outcome: SearchGrabOutcome = "acknowledged";
		try {
			await grabVerifiedProwlarrTargetWithSdk(client, {
				guid: target.guid,
				indexerId: target.indexerId,
			});
		} catch (error) {
			outcome =
				error instanceof ArrError &&
				error.statusCode >= 400 &&
				error.statusCode < 500 &&
				error.statusCode !== 408 &&
				error.statusCode !== 429
					? "rejected"
					: "uncertain";
		}
		// Deliberately outside the sender catch: a failed ACK write is not provider rejection.
		try {
			return safeStatus(
				await repository.settle(
					attemptId,
					outcome,
					outcome === "acknowledged"
						? undefined
						: outcome === "rejected"
							? "provider-rejected"
							: "transport-unconfirmed",
				),
			);
		} catch {
			throw new SearchGrabServiceError();
		}
	}
	return Object.freeze({ submit, status, resultStatuses });
}
