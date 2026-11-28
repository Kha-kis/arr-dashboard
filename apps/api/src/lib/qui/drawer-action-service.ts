import {
	type QuiDrawerOperation,
	quiDrawerAuditSummarySchema,
	quiTrackerSelectorSchema,
} from "@arr/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import type { QuiClient } from "./client-factory.js";
import {
	type ExecuteQuiActionResult,
	executeQuiFencedAction,
	QuiPreflightError,
} from "./fenced-action-executor.js";
import { QuiTrackerSelectionError, resolveQuiTrackerSelection } from "./tracker-selection.js";

const renameInputSchema = z.object({ name: z.string().min(1).max(1024) }).strict();
const addTrackersInputSchema = z
	.object({ urls: z.array(z.string().min(1)).min(1).max(50) })
	.strict();
const selectorSelectionSchema = z
	.object({ trackerSelectors: z.array(quiTrackerSelectorSchema).min(1).max(50) })
	.strict();
const hostnameSelectionSchema = z
	.object({ hostnames: z.array(z.string().min(1)).min(1).max(50) })
	.strict();
const trackerSelectionSchema = z.union([selectorSelectionSchema, hostnameSelectionSchema]);
const removeTrackersInputSchema = trackerSelectionSchema;
const editTrackerInputSchema = z.union([
	selectorSelectionSchema.extend({ newURL: z.string().min(1) }).strict(),
	hostnameSelectionSchema.extend({ newURL: z.string().min(1) }).strict(),
]);

export type QuiDrawerActionInput =
	| { action: "renameTorrent"; input: z.infer<typeof renameInputSchema> }
	| { action: "addTrackers"; input: z.infer<typeof addTrackersInputSchema> }
	| { action: "removeTrackers"; input: z.infer<typeof removeTrackersInputSchema> }
	| { action: "editTracker"; input: z.infer<typeof editTrackerInputSchema> };

export interface ExecuteQuiDrawerActionArgs {
	app: FastifyInstance;
	client: QuiClient;
	userId: string;
	serviceInstanceId: string;
	qbitInstanceId: number;
	hash: string;
	operation: QuiDrawerActionInput;
	log?: FastifyBaseLogger;
}

function validateOperation(operation: QuiDrawerActionInput): QuiDrawerActionInput {
	switch (operation.action) {
		case "renameTorrent":
			return { action: operation.action, input: renameInputSchema.parse(operation.input) };
		case "addTrackers":
			return { action: operation.action, input: addTrackersInputSchema.parse(operation.input) };
		case "removeTrackers":
			return { action: operation.action, input: removeTrackersInputSchema.parse(operation.input) };
		case "editTracker":
			return { action: operation.action, input: editTrackerInputSchema.parse(operation.input) };
	}
}

function drawerOperation(operation: QuiDrawerActionInput): QuiDrawerOperation {
	return operation.action;
}

function buildDispatch(
	client: QuiClient,
	qbitInstanceId: number,
	hash: string,
	operation: QuiDrawerActionInput,
	selectionUrls?: string[],
): () => Promise<void> {
	switch (operation.action) {
		case "renameTorrent":
			return async () => await client.renameTorrent(qbitInstanceId, hash, operation.input.name);
		case "addTrackers":
			return async () => await client.addTrackers(qbitInstanceId, hash, operation.input.urls);
		case "removeTrackers":
			return async () => await client.removeTrackers(qbitInstanceId, hash, selectionUrls!);
		case "editTracker":
			return async () =>
				await client.editTracker(qbitInstanceId, hash, selectionUrls![0]!, operation.input.newURL);
	}
}

function trackerSelectionFor(operation: QuiDrawerActionInput) {
	if (operation.action === "removeTrackers") return operation.input;
	if (operation.action === "editTracker") {
		const { newURL: _newURL, ...selection } = operation.input;
		return selection;
	}
	return null;
}

export async function executeQuiDrawerAction(
	args: ExecuteQuiDrawerActionArgs,
): Promise<ExecuteQuiActionResult> {
	const operation = validateOperation(args.operation);
	const selection = trackerSelectionFor(operation);
	const auditPayload =
		operation.action === "renameTorrent"
			? null
			: quiDrawerAuditSummarySchema.parse({
					trackerCount:
						operation.action === "addTrackers"
							? operation.input.urls.length
							: operation.action === "removeTrackers"
								? "trackerSelectors" in operation.input
									? operation.input.trackerSelectors.length
									: operation.input.hostnames.length
								: 1,
				});
	return executeQuiFencedAction({
		app: args.app,
		client: args.client,
		userId: args.userId,
		serviceInstanceId: args.serviceInstanceId,
		qbitInstanceId: args.qbitInstanceId,
		hashes: [args.hash],
		action: drawerOperation(operation),
		auditPayload,
		log: args.log,
		prepareDispatch: async () => {
			if (!selection) return buildDispatch(args.client, args.qbitInstanceId, args.hash, operation);
			let trackers: Awaited<ReturnType<QuiClient["getTrackers"]>>;
			try {
				trackers = await args.client.getTrackers(args.qbitInstanceId, args.hash);
			} catch {
				throw new QuiPreflightError(
					"tracker_lookup",
					"Could not load trackers from qUI; no tracker mutation was dispatched.",
				);
			}
			try {
				const urls = resolveQuiTrackerSelection(
					args.app.encryptor,
					{
						userId: args.userId,
						serviceInstanceId: args.serviceInstanceId,
						qbitInstanceId: args.qbitInstanceId,
						hash: args.hash,
					},
					trackers,
					selection,
				);
				return buildDispatch(args.client, args.qbitInstanceId, args.hash, operation, urls);
			} catch (error) {
				if (error instanceof QuiTrackerSelectionError) {
					throw new QuiPreflightError(
						"selection",
						"The requested tracker selection is no longer unique; refresh trackers and inspect qUI.",
					);
				}
				throw new QuiPreflightError(
					"selection",
					"The requested tracker selection could not be verified; no mutation was dispatched.",
				);
			}
		},
	});
}
