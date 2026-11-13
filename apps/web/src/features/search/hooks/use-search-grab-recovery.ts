"use client";

import type { SearchGrabRequest, SearchGrabStatus, SearchResult } from "@arr/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGrabSearchResultMutation } from "../../../hooks/api/useSearch";
import { ApiError } from "../../../lib/api-client/base";
import {
	fetchSearchGrabResultStatuses,
	fetchSearchGrabStatus,
} from "../../../lib/api-client/search";
import { getLinuxIsoName } from "../../../lib/incognito";
import { POLLING_FAST } from "../../../lib/polling-intervals";
import { QUEUE_QUERY_KEY, searchKeys } from "../../../lib/query-keys";
import { deriveGrabErrorMessage } from "../lib/search-utils";
import type { SearchStateActions } from "./use-search-state";

type RecoveryState =
	| SearchGrabStatus["state"]
	| "checking"
	| "not-recorded"
	| "unknown"
	| "new-search";
type Observation = {
	state: RecoveryState;
	status?: SearchGrabStatus;
	retryRejected?: boolean;
};
export interface SearchGrabRowState {
	state: RecoveryState;
	label: string;
	message: string;
	disabled: boolean;
}
interface Confirmation {
	result: SearchResult;
	predecessorId: string;
	generation: string;
}
const UNKNOWN =
	"Could not confirm the grab result. Check Prowlarr and the download client before retrying.";
const NEW_SEARCH = "This result cannot authorize a submission. Run a new search.";
const targetKey = (row: SearchResult) =>
	JSON.stringify([row.instanceId, row.indexerId, row.guid ?? row.id]);
const rowKey = (row: SearchResult) => `${row.instanceId}:${row.indexerId}:${row.id}`;
function newUuid() {
	if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6]! & 0x0f) | 0x40;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const descriptions: Record<RecoveryState, { label: string; message: string; disabled: boolean }> = {
	checking: { label: "Checking status…", message: "Checking submission status.", disabled: true },
	"not-recorded": {
		label: "Grab",
		message: "No dashboard submission recorded. This does not rule out an earlier download.",
		disabled: false,
	},
	unknown: {
		label: "Check status",
		message:
			"Submission outcome is unknown. Check Prowlarr and the download client before submitting again.",
		disabled: false,
	},
	"new-search": { label: "New search needed", message: NEW_SEARCH, disabled: true },
	prepared: {
		label: "Check status",
		message: "Submission is being prepared. Observe its status; do not submit again.",
		disabled: false,
	},
	submitting: {
		label: "Check status",
		message: "Submission is in progress. Observe its status; do not submit again.",
		disabled: false,
	},
	acknowledged: {
		label: "Sent",
		message: "Submission acknowledged by the download client.",
		disabled: true,
	},
	rejected: {
		label: "New search needed",
		message: "Submission rejected. Check Prowlarr and run a new search.",
		disabled: true,
	},
	uncertain: {
		label: "Review duplicate risk",
		message:
			"This submission may already have reached the download client. Check Prowlarr and the download client; submitting again may create a duplicate.",
		disabled: false,
	},
};
const describeObservation = (observation: Observation) =>
	observation.state === "rejected" &&
	observation.status?.outcomeCategory === "predecessor-acknowledged"
		? {
				label: "Retry cancelled",
				message:
					"Earlier submission acknowledged. This retry was not sent; check Prowlarr and the download client.",
				disabled: true,
			}
		: descriptions[observation.state];

/** Visible-result reads are observation only. Dispatch requires a fresh explicit action. */
export function useSearchGrabRecovery(results: SearchResult[], actions: SearchStateActions) {
	const client = useQueryClient();
	const mutation = useGrabSearchResultMutation();
	const generation = useMemo(() => ({ id: newUuid(), rows: results }), [results]);
	const current = useRef<typeof generation | null>(generation);
	current.current = generation;
	const observations = useRef(new Map<string, Observation>());
	const attempts = useRef(
		new Map<
			string,
			{
				intentId: string;
				selector: SearchResult["grabSelector"];
				status?: SearchGrabStatus;
				acknowledged?: boolean;
			}
		>(),
	);
	const busy = useRef(new Set<string>());
	const revisions = useRef(new Map<string, number>());
	const announced = useRef(new Set<string>());
	const [view, setView] = useState<{ generation: string; observations: Map<string, Observation> }>({
		generation: generation.id,
		observations: new Map(),
	});
	const confirmationRef = useRef<Confirmation | null>(null);
	const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
	const consent = useRef(false);
	const [duplicateRiskConfirmed, setConsent] = useState(false);
	const [confirming, setConfirming] = useState(false);

	useEffect(
		() => () => {
			if (current.current === generation) current.current = null;
		},
		[generation],
	);
	const isCurrent = useCallback(
		(row: SearchResult) =>
			current.current === generation &&
			generation.rows.some(
				(visible) =>
					targetKey(visible) === targetKey(row) && visible.grabSelector === row.grabSelector,
			),
		[generation],
	);
	const feedback = useCallback(
		(message: string) => actions.setFeedback({ type: "error", message, incognitoMessage: message }),
		[actions],
	);
	const publish = useCallback(
		(row: SearchResult, observation: Observation) => {
			if (!isCurrent(row)) return;
			observations.current.set(targetKey(row), observation);
			setView((previous) => {
				const next = new Map(previous.generation === generation.id ? previous.observations : []);
				next.set(targetKey(row), observation);
				return { generation: generation.id, observations: next };
			});
		},
		[generation.id, isCurrent],
	);
	const acknowledge = useCallback(
		(row: SearchResult, receiptId: string, recovered: boolean) => {
			if (!isCurrent(row) || announced.current.has(receiptId)) return;
			announced.current.add(receiptId);
			if (recovered) void client.invalidateQueries({ queryKey: QUEUE_QUERY_KEY });
			actions.setFeedback({
				type: "success",
				message: `Sent "${row.title}" to the download client.`,
				incognitoMessage: `Sent "${getLinuxIsoName(row.title)}" to the download client.`,
			});
		},
		[actions, client, isCurrent],
	);
	const readIntent = useCallback(
		async (intentId: string): Promise<Observation> => {
			try {
				const status = await client.fetchQuery({
					queryKey: searchKeys.grabIntent(intentId),
					queryFn: () => fetchSearchGrabStatus(intentId),
					staleTime: 0,
					gcTime: 0,
					retry: false,
				});
				return { state: status.state, status };
			} catch {
				return { state: "unknown" };
			}
		},
		[client],
	);
	const resolveObservation = useCallback(
		async (row: SearchResult, observation: Observation): Promise<Observation> => {
			const key = targetKey(row),
				attempted = attempts.current.get(key);
			// Exact held result status wins over a later rejected local successor.
			// A negative lookup cannot erase an intent whose request already started.
			if (observation.status) {
				if (!attempted)
					attempts.current.set(key, {
						intentId: observation.status.intentId,
						selector: row.grabSelector,
						status: observation.status,
					});
				// The result endpoint prefers held predecessors, but an unheld
				// rejected successor may mean its predecessor already succeeded.
				// Only positive refusal/unsent evidence permits an ordinary retry;
				// intent GET alone provides no equivalent authority.
				return observation.state === "rejected" &&
					["provider-rejected", "interrupted-before-dispatch"].includes(
						observation.status.outcomeCategory ?? "",
					)
					? { ...observation, retryRejected: true }
					: observation;
			}
			if (attempted) {
				const known: Observation = attempted.acknowledged
					? { state: "acknowledged" }
					: await readIntent(attempted.intentId);
				attempted.status = known.status;
				if (
					attempted.selector !== row.grabSelector &&
					["acknowledged", "rejected"].includes(known.state)
				) {
					// A terminal receipt for another selector cannot describe this row.
					// Release its local block only after a successful current negative
					// lookup. Missing/failed reads and unresolved intents stay held.
					if (observation.state === "not-recorded") {
						if (attempts.current.get(key) === attempted) attempts.current.delete(key);
						return observation;
					}
					return { state: "unknown" };
				}
				// An intent GET observes delivery state, but cannot prove that this
				// selector still authorizes the exact predecessor for another send.
				return known.state === "uncertain" ? { ...known, state: "unknown" } : known;
			}
			return observation;
		},
		[readIntent],
	);
	const readRows = useCallback(
		async (rows: SearchResult[]) => {
			const states = new Map<string, Observation>();
			const selected = [
				...new Map(
					rows.map((row) => [JSON.stringify([row.instanceId, row.grabSelector]), row]),
				).values(),
			];
			for (let offset = 0; offset < selected.length; offset += 50) {
				if (current.current !== generation) break;
				const chunk = selected.slice(offset, offset + 50);
				try {
					const response = await fetchSearchGrabResultStatuses({
						results: chunk.map((row) => ({
							instanceId: row.instanceId,
							selector: row.grabSelector!,
						})),
					});
					await Promise.all(
						chunk.map(async (row, index) => {
							const result = response.results[index]!;
							const observed: Observation =
								result.availability === "recorded"
									? { state: result.status.state, status: result.status }
									: { state: result.availability === "not-recorded" ? "not-recorded" : "unknown" };
							states.set(targetKey(row), await resolveObservation(row, observed));
						}),
					);
				} catch {
					await Promise.all(
						chunk.map(async (row) =>
							states.set(targetKey(row), await resolveObservation(row, { state: "unknown" })),
						),
					);
				}
			}
			return states;
		},
		[generation, resolveObservation],
	);

	useQuery({
		queryKey: searchKeys.grabResults(generation.id),
		enabled: results.some((row) => Boolean(row.grabSelector)),
		retry: false,
		gcTime: 0,
		refetchOnWindowFocus: false,
		refetchInterval: () =>
			[...observations.current.values()].some((observed) =>
				["prepared", "submitting", "unknown"].includes(observed.state),
			)
				? POLLING_FAST
				: false,
		queryFn: async () => {
			const visible = generation.rows.filter((row) => row.grabSelector);
			const versions = new Map(
				visible.map((row) => [targetKey(row), revisions.current.get(targetKey(row)) ?? 0]),
			);
			const states = await readRows(visible);
			for (const row of visible) {
				const key = targetKey(row),
					observed = states.get(key)!;
				if (
					!isCurrent(row) ||
					busy.current.has(key) ||
					versions.get(key) !== (revisions.current.get(key) ?? 0)
				)
					continue;
				publish(row, observed);
				if (observed.status?.state === "acknowledged")
					acknowledge(row, observed.status.intentId, true);
			}
			// No selector or provider identity is retained in the query cache.
			return [...states.values()];
		},
	});

	const cancelConfirmation = useCallback(() => {
		confirmationRef.current = null;
		consent.current = false;
		setConfirmation(null);
		setConsent(false);
	}, []);
	const setDuplicateRiskConfirmed = useCallback((checked: boolean) => {
		consent.current = checked;
		setConsent(checked);
	}, []);
	const send = useCallback(
		async (row: SearchResult, retry?: SearchGrabRequest["retry"]) => {
			if (!isCurrent(row)) return;
			const intentId = newUuid(),
				key = targetKey(row);
			attempts.current.set(key, { intentId, selector: row.grabSelector });
			actions.setGrabbingKey(rowKey(row));
			actions.setFeedback(null);
			publish(row, { state: "submitting" });
			try {
				await mutation.mutateAsync({
					instanceId: row.instanceId,
					selector: row.grabSelector!,
					intentId,
					...(retry ? { retry } : {}),
				});
				attempts.current.set(key, { intentId, selector: row.grabSelector, acknowledged: true });
				publish(row, { state: "acknowledged" });
				acknowledge(row, intentId, false);
			} catch (error) {
				// Even an expired selector cannot prevent recovery of this exact intent.
				const recovered = await readIntent(intentId);
				attempts.current.set(key, {
					intentId,
					selector: row.grabSelector,
					status: recovered.status,
				});
				if (!isCurrent(row)) return;
				publish(row, recovered);
				if (recovered.state === "acknowledged") acknowledge(row, intentId, true);
				else {
					const safeDenial =
						error instanceof ApiError &&
						error.status >= 400 &&
						error.status < 500 &&
						error.status !== 408 &&
						error.status !== 429
							? deriveGrabErrorMessage(error, true)
							: UNKNOWN;
					feedback(
						recovered.state === "rejected" &&
							recovered.status?.outcomeCategory === "predecessor-acknowledged"
							? describeObservation(recovered).message
							: safeDenial !== UNKNOWN
								? safeDenial
								: recovered.state === "unknown"
									? UNKNOWN
									: describeObservation(recovered).message,
					);
				}
			} finally {
				if (isCurrent(row)) actions.setGrabbingKey(null);
			}
		},
		[acknowledge, actions, feedback, isCurrent, mutation, publish, readIntent],
	);

	const handleGrab = useCallback(
		async (row: SearchResult) => {
			if (!isCurrent(row)) return;
			if (!row.grabSelector) {
				feedback(NEW_SEARCH);
				return;
			}
			const key = targetKey(row);
			if (busy.current.has(key)) return;
			busy.current.add(key);
			revisions.current.set(key, (revisions.current.get(key) ?? 0) + 1);
			try {
				const observed = (await readRows([row])).get(key)!;
				if (!isCurrent(row)) return;
				publish(row, observed);
				if (observed.state === "acknowledged") {
					acknowledge(
						row,
						observed.status?.intentId ?? attempts.current.get(key)?.intentId ?? key,
						true,
					);
					return;
				}
				if (observed.state === "uncertain" && observed.status) {
					const next = {
						result: row,
						predecessorId: observed.status.attemptId,
						generation: generation.id,
					};
					confirmationRef.current = next;
					consent.current = false;
					setConsent(false);
					setConfirmation(next);
					return;
				}
				if (
					(observed.state === "not-recorded" && !attempts.current.has(key)) ||
					(observed.state === "rejected" && observed.retryRejected)
				) {
					await send(row);
					return;
				}
				feedback(observed.state === "unknown" ? UNKNOWN : describeObservation(observed).message);
			} finally {
				busy.current.delete(key);
			}
		},
		[acknowledge, feedback, generation.id, isCurrent, publish, readRows, send],
	);

	const confirmRetry = useCallback(async () => {
		const pending = confirmationRef.current;
		if (
			!pending ||
			!consent.current ||
			pending.generation !== generation.id ||
			!isCurrent(pending.result)
		)
			return;
		const key = targetKey(pending.result);
		if (busy.current.has(key)) return;
		busy.current.add(key);
		revisions.current.set(key, (revisions.current.get(key) ?? 0) + 1);
		setConfirming(true);
		try {
			const observed = (await readRows([pending.result])).get(key)!;
			if (!isCurrent(pending.result) || confirmationRef.current !== pending || !consent.current)
				return;
			publish(pending.result, observed);
			cancelConfirmation();
			if (observed.state === "uncertain" && observed.status?.attemptId === pending.predecessorId) {
				await send(pending.result, {
					predecessorId: pending.predecessorId,
					duplicateRiskConfirmed: true,
				});
			} else if (observed.state === "acknowledged")
				acknowledge(pending.result, observed.status!.intentId, true);
			else
				feedback(
					observed.state === "unknown"
						? UNKNOWN
						: observed.state === "rejected" &&
								observed.status?.outcomeCategory === "predecessor-acknowledged"
							? describeObservation(observed).message
							: "Submission status changed. Review its current status before taking further action.",
				);
		} finally {
			busy.current.delete(key);
			if (current.current === generation) setConfirming(false);
		}
	}, [acknowledge, cancelConfirmation, feedback, generation, isCurrent, publish, readRows, send]);

	const getRowState = (row: SearchResult): SearchGrabRowState => {
		const observed: Observation | undefined = !row.grabSelector
			? { state: "new-search" as const }
			: view.generation === generation.id
				? view.observations.get(targetKey(row))
				: undefined;
		const state = observed?.state ?? "checking";
		if (state === "rejected" && observed?.retryRejected)
			return {
				state,
				label: "Retry rejected grab",
				message:
					"Submission rejected. This freshly searched result permits an explicit new attempt.",
				disabled: false,
			};
		return { state, ...describeObservation(observed ?? { state }) };
	};
	return {
		handleGrab,
		getRowState,
		confirmation: confirmation?.generation === generation.id ? confirmation : null,
		duplicateRiskConfirmed,
		setDuplicateRiskConfirmed,
		cancelConfirmation,
		confirmRetry,
		confirming,
	};
}
