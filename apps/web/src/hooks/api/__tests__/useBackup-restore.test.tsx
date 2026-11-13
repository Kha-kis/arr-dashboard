import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	acknowledgeProtectedUnauthorized,
	getPendingUnauthorizedRevision,
} from "../../../lib/auth-session-signal";
import { authKeys, backupKeys } from "../../../lib/query-keys";
import * as backupHooks from "../useBackup";
import { useRestoreBackup, useRestoreStatus } from "../useBackup";

const restoreId = "767478b4-9726-485c-bc91-c379fb118d12";
const committed = {
	restoreId,
	outcome: "committed",
	success: true,
	reason: null,
	restartRequired: true,
	restart: "manual-required",
};
const refused = {
	restoreId,
	outcome: "not-committed",
	success: false,
	reason: "state-changed",
	restartRequired: true,
	restart: "manual-required",
};
const unavailable = {
	restoreId,
	outcome: "unavailable",
	success: false,
	reason: "commit-unknown",
	restartRequired: true,
	restart: "manual-required",
};
const clients: QueryClient[] = [];
function wrapper() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: 2, retryDelay: 0 } },
	});
	clients.push(client);
	client.setQueryData(authKeys.currentUser, { id: "synthetic-old-account" });
	client.setQueryData(["synthetic-library"], { private: "synthetic-old-cache" });
	return {
		client,
		Wrapper: ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		),
	};
}
function response(payload: unknown, status: number) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	backupHooks.clearRestoreHandoff?.();
	vi.unstubAllGlobals();
	acknowledgeProtectedUnauthorized(getPendingUnauthorizedRevision());
});

describe.each(["upload", "stored"] as const)("actual query cache and %s Restore hook", (kind) => {
	const input = () =>
		kind === "upload"
			? {
					kind,
					request: {
						backupData: "synthetic-private-envelope",
						password: "synthetic-private-password",
					},
				}
			: { kind, request: { id: "a".repeat(24), password: "synthetic-private-password" } };

	it.each([
		[200, committed],
		[409, refused],
		[503, unavailable],
	] as const)(
		"does not retain sensitive variables or allow resubmission after HTTP %i",
		async (status, payload) => {
			let calls = 0;
			vi.stubGlobal("fetch", async () => {
				calls++;
				return response(payload, status);
			});
			const { client, Wrapper } = wrapper();
			const { result } = renderHook(() => useRestoreBackup(), { wrapper: Wrapper });
			let actual: unknown;
			await act(async () => {
				actual = await result.current.mutateAsync(input());
			});
			expect(actual).toEqual(payload);
			expect(result.current.isBlocked).toBe(true);
			await act(async () => {
				await expect(result.current.mutateAsync(input())).rejects.toThrow("Do not repeat");
			});
			expect(calls).toBe(1);
			await waitFor(() => expect(client.getMutationCache().getAll()).toHaveLength(0));
			if (status === 200 || status === 503) {
				expect(client.getQueryData(["synthetic-library"])).toBeUndefined();
				expect(client.getQueryData(authKeys.currentUser)).toBeNull();
				expect(getPendingUnauthorizedRevision()).toBeGreaterThan(0);
			} else {
				expect(client.getQueryData(["synthetic-library"])).toEqual({
					private: "synthetic-old-cache",
				});
				expect(getPendingUnauthorizedRevision()).toBe(0);
			}
		},
	);

	it("overrides global retries for a disconnected POST and remains blocked after settlement", async () => {
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls++;
			throw new Error("synthetic-private-transport");
		});
		const { client, Wrapper } = wrapper();
		const { result } = renderHook(() => useRestoreBackup(), { wrapper: Wrapper });
		await act(async () => {
			await expect(result.current.mutateAsync(input())).rejects.toMatchObject({
				name: "RestoreUnconfirmedError",
			});
		});
		expect(result.current.isBlocked).toBe(true);
		await act(async () => {
			await expect(result.current.mutateAsync(input())).rejects.toThrow("Do not repeat");
		});
		expect(calls).toBe(1);
		await waitFor(() => expect(client.getMutationCache().getAll()).toHaveLength(0));
		expect(client.getQueryData(["synthetic-library"])).toBeUndefined();
		expect(client.getQueryData(authKeys.currentUser)).toBeNull();
	});

	it("permits explicit form correction only after a verified pre-publication rejection", async () => {
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls++;
			return calls === 1
				? response({ error: "Restore request rejected", category: "invalid-backup" }, 400)
				: response(committed, 200);
		});
		const { client, Wrapper } = wrapper();
		const { result } = renderHook(() => useRestoreBackup(), { wrapper: Wrapper });
		await act(async () => {
			await expect(result.current.mutateAsync(input())).rejects.toMatchObject({
				name: "RestoreRequestRejectedError",
			});
		});
		expect(result.current.isBlocked).toBe(false);
		expect(client.getQueryData(["synthetic-library"])).toEqual({ private: "synthetic-old-cache" });
		expect(calls).toBe(1);
		await act(async () => {
			await expect(result.current.mutateAsync(input())).resolves.toEqual(committed);
		});
		expect(calls).toBe(2);
		await waitFor(() => expect(client.getMutationCache().getAll()).toHaveLength(0));
	});

	it("retains account/cache and permits only explicit correction after a verified rate-limit refusal", async () => {
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls++;
			return response(
				{
					error: "Restore request rejected",
					category: "restore-rate-limited",
					retryAfterSeconds: 300,
				},
				429,
			);
		});
		const { client, Wrapper } = wrapper();
		const { result } = renderHook(() => useRestoreBackup(), { wrapper: Wrapper });
		await act(async () => {
			await expect(result.current.mutateAsync(input())).rejects.toMatchObject({
				name: "RestoreRequestRejectedError",
				status: 429,
			});
		});
		expect(result.current.isBlocked).toBe(false);
		expect(result.current.handoff).toBeNull();
		expect(client.getQueryData(authKeys.currentUser)).toEqual({ id: "synthetic-old-account" });
		expect(client.getQueryData(["synthetic-library"])).toEqual({ private: "synthetic-old-cache" });
		expect(getPendingUnauthorizedRevision()).toBe(0);
		expect(calls).toBe(1);
		await waitFor(() => expect(client.getMutationCache().getAll()).toHaveLength(0));
	});

	it("keeps an ordinary gateway429 quarantined and never retries it", async () => {
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls++;
			return response({ error: "Gateway rate limit" }, 429);
		});
		const { client, Wrapper } = wrapper();
		const { result } = renderHook(() => useRestoreBackup(), { wrapper: Wrapper });
		await act(async () => {
			await expect(result.current.mutateAsync(input())).rejects.toMatchObject({
				name: "RestoreUnconfirmedError",
			});
		});
		expect(result.current.isBlocked).toBe(true);
		expect(client.getQueryData(authKeys.currentUser)).toBeNull();
		expect(client.getQueryData(["synthetic-library"])).toBeUndefined();
		expect(calls).toBe(1);
	});

	it("excludes passwords and envelopes from mutation state while pending and blocks a synchronous second submit", async () => {
		let release!: (value: Response) => void;
		let calls = 0;
		vi.stubGlobal("fetch", () => {
			calls++;
			return new Promise<Response>((resolve) => {
				release = resolve;
			});
		});
		const { client, Wrapper } = wrapper();
		const { result } = renderHook(() => useRestoreBackup(), { wrapper: Wrapper });
		let first!: ReturnType<typeof result.current.mutateAsync>;
		act(() => {
			first = result.current.mutateAsync(input());
		});
		await waitFor(() => expect(result.current.isPending).toBe(true));
		const pending = client.getMutationCache().getAll();
		expect(pending).toHaveLength(1);
		expect(pending[0]!.state.variables).toBeUndefined();
		expect(JSON.stringify(pending[0]!.state)).not.toContain("synthetic-private");
		try {
			await act(async () => {
				await expect(result.current.mutateAsync(input())).rejects.toThrow("Do not repeat");
			});
			expect(calls).toBe(1);
		} finally {
			await act(async () => {
				release(response(refused, 409));
				await first;
			});
		}
		await waitFor(() => expect(client.getMutationCache().getAll()).toHaveLength(0));
	});
});

it("cancels real in-flight queries before clearing account data on a verified commit", async () => {
	vi.stubGlobal("fetch", async () => response(committed, 200));
	const { client, Wrapper } = wrapper();
	let release!: (value: string) => void;
	const old = client.fetchQuery({
		queryKey: ["synthetic-running-query"],
		queryFn: () =>
			new Promise<string>((resolve) => {
				release = resolve;
			}),
	});
	void old.catch(() => {});
	const { result } = renderHook(() => useRestoreBackup(), { wrapper: Wrapper });
	await act(async () => {
		await result.current.mutateAsync({ kind: "stored", request: { id: "a".repeat(24) } });
	});
	await expect(old).rejects.toMatchObject({ revert: true });
	release("synthetic-old-data");
	await Promise.resolve();
	expect(client.getQueryData(["synthetic-running-query"])).toBeUndefined();
	expect(client.getQueryData(authKeys.currentUser)).toBeNull();
});

it("only fetches protected positive status when explicitly enabled and never publishes", async () => {
	const calls: Array<{ url: string; method: string | undefined }> = [];
	vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
		calls.push({ url, method: options.method });
		return response({ latestCommitted: null }, 200);
	});
	const { client, Wrapper } = wrapper();
	const { result, rerender } = renderHook(({ enabled }) => useRestoreStatus(enabled), {
		wrapper: Wrapper,
		initialProps: { enabled: false },
	});
	expect(calls).toEqual([]);
	rerender({ enabled: true });
	await waitFor(() => expect(result.current.isSuccess).toBe(true));
	expect(result.current.data).toEqual({ latestCommitted: null });
	expect(client.getQueryData(backupKeys.restoreStatus)).toEqual({ latestCommitted: null });
	expect(calls).toEqual([{ url: "/api/backup/restore/status", method: "GET" }]);
});
