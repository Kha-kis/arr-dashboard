import type { SearchGrabStatus, SearchResult } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { QUEUE_QUERY_KEY } from "../../../../lib/query-keys";
import { useSearchGrabRecovery } from "../use-search-grab-recovery";
import { useSearchState } from "../use-search-state";

const row: SearchResult = {
	id: "PRIVATE_GUID",
	guid: "PRIVATE_GUID",
	title: "PRIVATE_TITLE",
	indexer: "PRIVATE_INDEXER",
	indexerId: 7,
	protocol: "torrent",
	instanceId: "owned-instance",
	instanceName: "PRIVATE_CONNECTION",
	grabSelector: "sg1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
};
const predecessor = "11111111-1111-4111-8111-111111111111";
const priorIntent = "22222222-2222-4222-8222-222222222222";
function status(
	state: SearchGrabStatus["state"],
	attemptId = predecessor,
	intentId = priorIntent,
): SearchGrabStatus {
	return {
		attemptId,
		intentId,
		state,
		requestedAt: "2026-10-10T00:00:00.000Z",
		dispatchedAt: state === "prepared" ? null : "2026-10-10T00:00:01.000Z",
		completedAt: ["acknowledged", "rejected"].includes(state) ? "2026-10-10T00:00:02.000Z" : null,
		outcomeCategory:
			state === "uncertain"
				? "transport-unconfirmed"
				: state === "rejected"
					? "provider-rejected"
					: null,
		nextAction:
			state === "acknowledged"
				? "none"
				: state === "rejected"
					? "new-search"
					: state === "uncertain"
						? "inspect-before-confirmed-retry"
						: "observe-status",
	};
}
const json = (body: unknown, code = 200) =>
	new Response(JSON.stringify(body), {
		status: code,
		headers: { "content-type": "application/json" },
	});
type ResultObservation =
	| { availability: "recorded"; status: SearchGrabStatus }
	| { availability: "not-recorded" | "unavailable"; status: null };
let observation: ResultObservation;
let client: QueryClient;
let grab: (payload: Record<string, unknown>) => Promise<Response>;
let intentRead: (intent: string) => Promise<Response>;
let resultRead:
	| ((body: { results: Array<{ instanceId: string; selector: string }> }) => Promise<Response>)
	| undefined;
let sends: Array<Record<string, unknown>>;
let reads: Array<{ url: string; body?: unknown }>;
beforeEach(() => {
	client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: 2, retryDelay: 1 } },
	});
	observation = { availability: "not-recorded", status: null };
	sends = [];
	reads = [];
	resultRead = undefined;
	grab = async () => new Response(null, { status: 204 });
	intentRead = async () => json({ message: "PRIVATE_FAILURE" }, 404);
	vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
		const body = options.body ? JSON.parse(String(options.body)) : undefined;
		if (url === "/api/search/grab") {
			sends.push(body);
			return grab(body);
		}
		reads.push({ url, body });
		if (url === "/api/search/grab/results/status")
			return resultRead
				? resultRead(body)
				: json({
						results: body.results.map((_: unknown, resultIndex: number) => ({
							resultIndex,
							...observation,
						})),
					});
		if (url.startsWith("/api/search/grab/intents/")) return intentRead(url.split("/").at(-1)!);
		throw new Error("Unexpected synthetic endpoint");
	});
});
afterEach(() => {
	cleanup();
	client.clear();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
function mount(rows: SearchResult[] = [row]) {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<IncognitoProvider>{children}</IncognitoProvider>
		</QueryClientProvider>
	);
	return renderHook(
		({ rows }) => {
			const state = useSearchState();
			return { state, ...useSearchGrabRecovery(rows, state.actions) };
		},
		{ initialProps: { rows }, wrapper },
	);
}
async function ready(hook: ReturnType<typeof mount>, result = row) {
	await waitFor(() => expect(hook.result.current.getRowState(result).state).not.toBe("checking"));
}

describe("actual read-first durable Grab recovery", () => {
	it("renders and sends a UUIDv4 intent without secure-context randomUUID", async () => {
		vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
		vi.stubGlobal("isSecureContext", false);
		const hook = mount();
		await ready(hook);
		await act(async () => hook.result.current.handleGrab(row));
		expect(sends).toHaveLength(1);
		expect(sends[0]!.intentId).toMatch(
			/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,
		);
		expect(hook.result.current.state.feedback?.type).toBe("success");
	});
	it.each(["local", "recovered"])(
		"does not publish an old %s ACK on a changed selector with current not-recorded proof",
		async (receipt) => {
			if (receipt === "recovered")
				grab = async () => {
					throw new Error("lost reply");
				};
			const hook = mount();
			await ready(hook);
			await act(async () => hook.result.current.handleGrab(row));
			const oldIntent = sends[0]!.intentId as string;
			intentRead = async () => json(status("acknowledged", predecessor, oldIntent));
			const changed = {
				...row,
				grabSelector: "sg1.CCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
			};
			act(() => hook.result.current.state.actions.setFeedback(null));
			hook.rerender({ rows: [changed] });
			await ready(hook, changed);
			expect(hook.result.current.getRowState(changed).state).toBe("not-recorded");
			expect(hook.result.current.state.feedback).toBeNull();
			expect(sends).toHaveLength(1);
			await act(async () => hook.result.current.handleGrab(changed));
			expect(sends).toHaveLength(2);
			expect(sends[1]!.selector).toBe(changed.grabSelector);
			expect(sends[1]!.intentId).not.toBe(oldIntent);
		},
	);
	it.each(["missing", "submitting", "uncertain"])(
		"preserves a %s known intent across an empty page and a changed-selector negative read",
		async (known) => {
			grab = async () => {
				throw new Error("lost reply");
			};
			const hook = mount();
			await ready(hook);
			await act(async () => hook.result.current.handleGrab(row));
			const oldIntent = sends[0]!.intentId as string;
			if (known !== "missing")
				intentRead = async () =>
					json(status(known as "submitting" | "uncertain", predecessor, oldIntent));
			hook.rerender({ rows: [] });
			const changed = {
				...row,
				grabSelector: "sg1.CCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
			};
			hook.rerender({ rows: [changed] });
			await ready(hook, changed);
			await act(async () => hook.result.current.handleGrab(changed));
			expect(sends).toHaveLength(1);
			expect(hook.result.current.confirmation).toBeNull();
			expect(hook.result.current.getRowState(changed).state).toBe(
				known === "submitting" ? "submitting" : "unknown",
			);
			expect(reads.at(-1)?.url).toBe(`/api/search/grab/intents/${oldIntent}`);
		},
	);
	it.each(["interrupted-before-dispatch", "provider-rejected"] as const)(
		"fresh recorded %s permits only an explicit new intent after another fresh read",
		async (outcomeCategory) => {
			observation = {
				availability: "recorded",
				status: {
					...status("rejected"),
					outcomeCategory,
					dispatchedAt:
						outcomeCategory === "interrupted-before-dispatch" ? null : "2026-10-10T00:00:01.000Z",
				},
			};
			const hook = mount();
			await ready(hook);
			expect(hook.result.current.getRowState(row)).toMatchObject({
				label: "Retry rejected grab",
				disabled: false,
			});
			expect(sends).toHaveLength(0);
			await act(async () =>
				Promise.all([hook.result.current.handleGrab(row), hook.result.current.handleGrab(row)]),
			);
			expect(reads.filter((r) => r.url.endsWith("results/status"))).toHaveLength(2);
			expect(sends).toHaveLength(1);
			expect(sends[0]!.intentId).not.toBe(priorIntent);
			expect(sends[0]!.retry).toBeUndefined();
			expect(hook.result.current.state.feedback?.type).toBe("success");
		},
	);
	it("does not offer or dispatch a retry cancelled by its predecessor acknowledgement", async () => {
		observation = {
			availability: "recorded",
			status: {
				...status("rejected"),
				dispatchedAt: null,
				outcomeCategory: "predecessor-acknowledged",
			},
		};
		const invalidation = vi.spyOn(client, "invalidateQueries"),
			hook = mount();
		await ready(hook);
		expect(hook.result.current.getRowState(row)).toMatchObject({
			state: "rejected",
			disabled: true,
		});
		expect(hook.result.current.getRowState(row).message).toMatch(
			/earlier submission acknowledged.*retry was not sent/i,
		);
		await act(async () => hook.result.current.handleGrab(row));
		expect(sends).toHaveLength(0);
		expect(hook.result.current.confirmation).toBeNull();
		expect(hook.result.current.state.feedback?.type).not.toBe("success");
		expect(hook.result.current.state.feedback?.message).toMatch(
			/earlier submission acknowledged.*retry was not sent/i,
		);
		expect(invalidation).not.toHaveBeenCalled();
	});
	it.each([null, "transport-unconfirmed", "interrupted-after-marker"] as const)(
		"a recorded rejected outcome %s without positive safe-retry evidence never authorizes a new send",
		async (outcomeCategory) => {
			observation = {
				availability: "recorded",
				status: { ...status("rejected"), outcomeCategory },
			};
			const hook = mount();
			await ready(hook);
			expect(hook.result.current.getRowState(row).disabled).toBe(true);
			await act(async () => hook.result.current.handleGrab(row));
			expect(sends).toHaveLength(0);
			expect(hook.result.current.confirmation).toBeNull();
		},
	);
	it.each(["ordinary-retry", "confirmed-retry"])(
		"a %s freshly observing predecessor acknowledgement does not dispatch",
		async (action) => {
			observation = {
				availability: "recorded",
				status: status(action === "ordinary-retry" ? "rejected" : "uncertain"),
			};
			const hook = mount();
			await ready(hook);
			if (action === "confirmed-retry") {
				await act(async () => hook.result.current.handleGrab(row));
				act(() => hook.result.current.setDuplicateRiskConfirmed(true));
			}
			observation = {
				availability: "recorded",
				status: {
					...status("rejected"),
					dispatchedAt: null,
					outcomeCategory: "predecessor-acknowledged",
				},
			};
			await act(async () =>
				action === "ordinary-retry"
					? hook.result.current.handleGrab(row)
					: hook.result.current.confirmRetry(),
			);
			expect(sends).toHaveLength(0);
			expect(hook.result.current.confirmation).toBeNull();
			expect(hook.result.current.getRowState(row).disabled).toBe(true);
			expect(hook.result.current.state.feedback?.message).toMatch(
				/earlier submission acknowledged.*retry was not sent/i,
			);
		},
	);
	it("intent recovery explains predecessor acknowledgement without publishing a successor success", async () => {
		grab = async () => {
			throw new Error("lost reply");
		};
		intentRead = async (intent) =>
			json({
				...status("rejected", predecessor, intent),
				dispatchedAt: null,
				outcomeCategory: "predecessor-acknowledged",
			});
		const invalidation = vi.spyOn(client, "invalidateQueries"),
			hook = mount();
		await ready(hook);
		await act(async () => hook.result.current.handleGrab(row));
		expect(sends).toHaveLength(1);
		expect(hook.result.current.getRowState(row)).toMatchObject({
			state: "rejected",
			disabled: true,
		});
		expect(hook.result.current.getRowState(row).message).toMatch(
			/earlier submission acknowledged.*retry was not sent/i,
		);
		expect(hook.result.current.state.feedback?.type).toBe("error");
		expect(hook.result.current.state.feedback?.message).toMatch(
			/earlier submission acknowledged.*retry was not sent/i,
		);
		expect(invalidation).not.toHaveBeenCalled();
		await act(async () => hook.result.current.handleGrab(row));
		expect(sends).toHaveLength(1);
	});
	it.each(["unavailable", "failed"])(
		"a %s current result read with a known rejected GET cannot authorize a new intent",
		async (read) => {
			observation = { availability: "recorded", status: status("rejected") };
			intentRead = async () => json(status("rejected"));
			const hook = mount();
			await ready(hook);
			if (read === "failed") resultRead = async () => json({ message: "private failure" }, 503);
			else observation = { availability: "unavailable", status: null };
			await act(async () => hook.result.current.handleGrab(row));
			expect(sends).toHaveLength(0);
			expect(hook.result.current.getRowState(row).disabled).toBe(true);
			expect(reads.at(-1)?.url).toBe(`/api/search/grab/intents/${priorIntent}`);
		},
	);
	it.each(["acknowledged", "submitting", "uncertain"] as const)(
		"rejected retry freshly observes %s instead of sending",
		async (state) => {
			observation = { availability: "recorded", status: status("rejected") };
			const hook = mount();
			await ready(hook);
			observation = { availability: "recorded", status: status(state) };
			await act(async () => hook.result.current.handleGrab(row));
			expect(sends).toHaveLength(0);
			expect(hook.result.current.getRowState(row).state).toBe(state);
			expect(hook.result.current.confirmation?.predecessorId ?? null).toBe(
				state === "uncertain" ? predecessor : null,
			);
		},
	);
	// Removing the fresh read or a ref guard must allow an unwanted second send.
	it("reads visible status and freshly reads before one explicit double-click send", async () => {
		const hook = mount();
		await ready(hook);
		await act(async () => {
			await Promise.all([hook.result.current.handleGrab(row), hook.result.current.handleGrab(row)]);
		});
		expect(reads.filter((r) => r.url.endsWith("results/status"))).toHaveLength(2);
		expect(sends).toHaveLength(1);
		expect(Object.keys(sends[0]!).sort()).toEqual(["instanceId", "intentId", "selector"]);
		expect(hook.result.current.state.feedback?.type).toBe("success");
	});
	it.each(["failure", "malformed", "missing", "unavailable"])(
		"never sends after %s result status",
		async (kind) => {
			resultRead = async () =>
				kind === "failure"
					? json({ message: "PRIVATE_FAILURE" }, 503)
					: kind === "malformed"
						? json({ results: [{ resultIndex: 0, availability: "recorded", status: {} }] })
						: kind === "missing"
							? json({ results: [] })
							: json({ results: [{ resultIndex: 0, availability: "unavailable", status: null }] });
			const hook = mount();
			await ready(hook);
			await act(async () => hook.result.current.handleGrab(row));
			expect(sends).toHaveLength(0);
			expect(hook.result.current.getRowState(row).state).toBe("unknown");
			expect(JSON.stringify(hook.result.current.state.feedback)).not.toContain("PRIVATE");
		},
	);
	it.each(["prepared", "submitting"] as const)("observes %s with no send", async (state) => {
		observation = { availability: "recorded", status: status(state) };
		const hook = mount();
		await ready(hook);
		await act(async () => hook.result.current.handleGrab(row));
		expect(sends).toHaveLength(0);
		expect(hook.result.current.getRowState(row).state).toBe(state);
	});
	it("polls an active visible intent to durable acknowledgement without dispatch", async () => {
		vi.useFakeTimers();
		observation = { availability: "recorded", status: status("submitting") };
		const invalidation = vi.spyOn(client, "invalidateQueries"),
			hook = mount();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(hook.result.current.getRowState(row).state).toBe("submitting");
		observation = { availability: "recorded", status: status("acknowledged") };
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(reads).toHaveLength(2);
		expect(sends).toHaveLength(0);
		expect(hook.result.current.state.feedback?.type).toBe("success");
		expect(invalidation).toHaveBeenCalledExactlyOnceWith({ queryKey: QUEUE_QUERY_KEY });
	});
	it("a previously recorded attempt cannot become a new send after a negative result lookup", async () => {
		observation = { availability: "recorded", status: status("rejected") };
		const hook = mount();
		await ready(hook);
		observation = { availability: "not-recorded", status: null };
		await act(async () => hook.result.current.handleGrab(row));
		expect(sends).toHaveLength(0);
		expect(hook.result.current.getRowState(row).state).toBe("unknown");
		expect(reads.at(-1)?.url).toBe(`/api/search/grab/intents/${priorIntent}`);
	});
	it("late bulk observation cannot overwrite a later explicit acknowledged action", async () => {
		let release!: (response: Response) => void;
		let count = 0;
		resultRead = async () =>
			++count === 1
				? new Promise((resolve) => {
						release = resolve;
					})
				: json({ results: [{ resultIndex: 0, availability: "not-recorded", status: null }] });
		const hook = mount();
		await waitFor(() => expect(count).toBe(1));
		await act(async () => hook.result.current.handleGrab(row));
		await act(async () =>
			release(
				json({
					results: [{ resultIndex: 0, availability: "recorded", status: status("uncertain") }],
				}),
			),
		);
		expect(sends).toHaveLength(1);
		expect(hook.result.current.getRowState(row).state).toBe("acknowledged");
		expect(hook.result.current.state.feedback?.type).toBe("success");
	});
	it("recovers lost POST by exact intent GET and invalidates only positive ACK", async () => {
		grab = async () => {
			throw new Error("PRIVATE_TRANSPORT");
		};
		intentRead = async (intent) => json(status("acknowledged", predecessor, intent));
		const invalidation = vi.spyOn(client, "invalidateQueries");
		const hook = mount();
		await ready(hook);
		await act(async () => hook.result.current.handleGrab(row));
		expect(sends).toHaveLength(1);
		expect(reads.at(-1)?.url).toBe(`/api/search/grab/intents/${sends[0]!.intentId}`);
		expect(hook.result.current.state.feedback?.type).toBe("success");
		expect(invalidation).toHaveBeenCalledExactlyOnceWith({ queryKey: QUEUE_QUERY_KEY });
	});
	it("unknown intent lookup stays held on repeated clicks even when result lookup says not recorded", async () => {
		grab = async () => {
			throw new Error("PRIVATE_TRANSPORT");
		};
		const invalidation = vi.spyOn(client, "invalidateQueries");
		const hook = mount();
		await ready(hook);
		await act(async () => hook.result.current.handleGrab(row));
		await act(async () => hook.result.current.handleGrab(row));
		expect(sends).toHaveLength(1);
		expect(reads.filter((r) => r.url.includes("/intents/"))).toHaveLength(2);
		expect(hook.result.current.getRowState(row).state).toBe("unknown");
		expect(invalidation).not.toHaveBeenCalled();
	});
	it("reads known intent despite unavailable expired selector", async () => {
		grab = async () => {
			throw new Error("lost");
		};
		const hook = mount();
		await ready(hook);
		await act(async () => hook.result.current.handleGrab(row));
		observation = { availability: "unavailable", status: null };
		intentRead = async (intent) => json(status("acknowledged", predecessor, intent));
		await act(async () => hook.result.current.handleGrab(row));
		expect(sends).toHaveLength(1);
		expect(hook.result.current.getRowState(row).state).toBe("acknowledged");
	});
	it("known uncertain intent cannot authorize retry when fresh selector lookup is unavailable", async () => {
		observation = { availability: "recorded", status: status("uncertain") };
		intentRead = async () => json(status("uncertain"));
		const hook = mount();
		await ready(hook);
		await act(async () => hook.result.current.handleGrab(row));
		act(() => hook.result.current.setDuplicateRiskConfirmed(true));
		observation = { availability: "unavailable", status: null };
		await act(async () => hook.result.current.confirmRetry());
		expect(sends).toHaveLength(0);
		expect(hook.result.current.getRowState(row).state).toBe("unknown");
		expect(hook.result.current.confirmation).toBeNull();
	});
	it("missing per-result record with a known uncertain intent cannot open another confirmation", async () => {
		observation = { availability: "recorded", status: status("uncertain") };
		intentRead = async () => json(status("uncertain"));
		const hook = mount();
		await ready(hook);
		observation = { availability: "not-recorded", status: null };
		await act(async () => hook.result.current.handleGrab(row));
		expect(sends).toHaveLength(0);
		expect(hook.result.current.confirmation).toBeNull();
		expect(hook.result.current.getRowState(row).state).toBe("unknown");
	});
	it("reload observes held uncertainty, cancellation and unchecked confirmation never send", async () => {
		observation = { availability: "recorded", status: status("uncertain") };
		const hook = mount();
		await ready(hook);
		await act(async () => hook.result.current.handleGrab(row));
		expect(hook.result.current.confirmation?.predecessorId).toBe(predecessor);
		await act(async () => hook.result.current.confirmRetry());
		expect(sends).toHaveLength(0);
		act(() => hook.result.current.cancelConfirmation());
		expect(hook.result.current.confirmation).toBeNull();
		expect(sends).toHaveLength(0);
	});
	it("confirmed retry freshly verifies predecessor and sends one new exact linked intent", async () => {
		observation = { availability: "recorded", status: status("uncertain") };
		const hook = mount();
		await ready(hook);
		await act(async () => hook.result.current.handleGrab(row));
		act(() => hook.result.current.setDuplicateRiskConfirmed(true));
		await act(async () => {
			await Promise.all([hook.result.current.confirmRetry(), hook.result.current.confirmRetry()]);
		});
		expect(sends).toHaveLength(1);
		expect(sends[0]).toMatchObject({
			instanceId: "owned-instance",
			selector: row.grabSelector,
			retry: { predecessorId: predecessor, duplicateRiskConfirmed: true },
		});
		expect(sends[0]!.intentId).not.toBe(priorIntent);
		expect(reads.filter((r) => r.url.endsWith("results/status"))).toHaveLength(3);
	});
	it.each(["changed-predecessor", "acknowledged", "submitting", "unavailable"])(
		"confirmation refuses %s and observes current outcome",
		async (change) => {
			observation = { availability: "recorded", status: status("uncertain") };
			const hook = mount();
			await ready(hook);
			await act(async () => hook.result.current.handleGrab(row));
			act(() => hook.result.current.setDuplicateRiskConfirmed(true));
			observation =
				change === "unavailable"
					? { availability: "unavailable", status: null }
					: {
							availability: "recorded",
							status: status(
								change === "changed-predecessor"
									? "uncertain"
									: (change as "acknowledged" | "submitting"),
								change === "changed-predecessor"
									? "33333333-3333-4333-8333-333333333333"
									: predecessor,
							),
						};
			await act(async () => hook.result.current.confirmRetry());
			expect(sends).toHaveLength(0);
			expect(hook.result.current.confirmation).toBeNull();
		},
	);
	it("held predecessor beats rejected local successor on subsequent observation", async () => {
		observation = { availability: "recorded", status: status("uncertain") };
		grab = async () => json({ message: "denied" }, 409);
		intentRead = async (intent) =>
			json(status("rejected", "33333333-3333-4333-8333-333333333333", intent));
		const hook = mount();
		await ready(hook);
		await act(async () => hook.result.current.handleGrab(row));
		act(() => hook.result.current.setDuplicateRiskConfirmed(true));
		await act(async () => hook.result.current.confirmRetry());
		await act(async () => hook.result.current.handleGrab(row));
		expect(sends).toHaveLength(1);
		expect(hook.result.current.getRowState(row).state).toBe("uncertain");
		expect(hook.result.current.confirmation?.predecessorId).toBe(predecessor);
	});
	it("new page fences an old read and saved action callback before dispatch", async () => {
		const hook = mount();
		await ready(hook);
		let release!: (value: Response) => void;
		resultRead = () =>
			new Promise((resolve) => {
				release = resolve;
			});
		const saved = hook.result.current.handleGrab;
		let pending!: Promise<void>;
		act(() => {
			pending = saved(row);
		});
		hook.rerender({ rows: [] });
		await act(async () => {
			release(json({ results: [{ resultIndex: 0, availability: "not-recorded", status: null }] }));
			await pending;
		});
		await act(async () => saved(row));
		expect(sends).toHaveLength(0);
		expect(hook.result.current.state.feedback).toBeNull();
	});
	it("confirmation cannot send after result selector changes", async () => {
		observation = { availability: "recorded", status: status("uncertain") };
		const hook = mount();
		await ready(hook);
		await act(async () => hook.result.current.handleGrab(row));
		act(() => hook.result.current.setDuplicateRiskConfirmed(true));
		const saved = hook.result.current.confirmRetry;
		hook.rerender({
			rows: [{ ...row, grabSelector: "sg1.CCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDDDDDDDDDD" }],
		});
		await act(async () => saved());
		expect(sends).toHaveLength(0);
		expect(hook.result.current.confirmation).toBeNull();
	});
	it("bounds and deduplicates visible batches and keeps provenance out of query keys and storage", async () => {
		const rows = Array.from({ length: 100 }, (_, i) => ({
			...row,
			id: `PRIVATE_GUID_${i}`,
			guid: `PRIVATE_GUID_${i}`,
			grabSelector: `sg1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB${i}`,
		}));
		const local = vi.spyOn(Storage.prototype, "setItem");
		const hook = mount([...rows, rows[0]!]);
		await ready(hook, rows[0]!);
		expect(reads.map((r) => (r.body as { results: unknown[] }).results.length)).toEqual([50, 50]);
		const keys = JSON.stringify(
			client
				.getQueryCache()
				.getAll()
				.map((q) => q.queryKey),
		);
		expect(keys).not.toContain("PRIVATE");
		expect(keys).not.toContain("sg1.");
		expect(keys).not.toContain("owned-instance");
		expect(local).not.toHaveBeenCalled();
	});
	it("changing pages prevents remaining hidden-row batches from starting", async () => {
		const rows = Array.from({ length: 100 }, (_, i) => ({
			...row,
			id: `row-${i}`,
			guid: `row-${i}`,
			grabSelector: `sg1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB${i}`,
		}));
		let release!: (response: Response) => void;
		resultRead = () =>
			new Promise((resolve) => {
				release = resolve;
			});
		const hook = mount(rows);
		await waitFor(() => expect(reads).toHaveLength(1));
		hook.rerender({ rows: [] });
		await act(async () => {
			release(
				json({
					results: Array.from({ length: 50 }, (_, resultIndex) => ({
						resultIndex,
						availability: "not-recorded",
						status: null,
					})),
				}),
			);
		});
		expect(reads).toHaveLength(1);
		expect(sends).toHaveLength(0);
	});
});
