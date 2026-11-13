import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BackupFileInfo, BackupSettings } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster, toast } from "../../../../components/ui/toast";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { BackupCreateCard } from "../backup-create-card";
import { BackupListSection } from "../backup-list-section";
import { BackupScheduleSection } from "../backup-schedule-section";

type Request = { url: string; method: string; body: unknown };
const json = (body: unknown, status = 200) =>
	new Response(status === 204 ? null : JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
let requests: Request[];
let alerts: string[];
let clients: QueryClient[];
let gates: Array<{ promise: Promise<void>; release: () => void }>;
let active: Set<Promise<Response>>;
let respond: (request: Request) => Promise<Response>;
const receipts: unknown[] = [];
const writes = () => requests.filter((request) => request.method !== "GET");
function hold() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	const gate = { promise, release };
	gates.push(gate);
	return gate;
}
beforeEach(() => {
	localStorage.clear();
	requests = [];
	alerts = [];
	clients = [];
	gates = [];
	active = new Set();
	respond = async (request) => {
		throw new Error(`Unexpected synthetic request ${request.method} ${request.url}`);
	};
	vi.stubGlobal(
		"alert",
		vi.fn((message: unknown) => {
			alerts.push(String(message));
		}),
	);
	vi.stubGlobal(
		"confirm",
		vi.fn(() => false),
	);
	vi.stubGlobal(
		"fetch",
		vi.fn((url: string, options?: RequestInit) => {
			const request = {
				url,
				method: options?.method ?? "GET",
				body: options?.body ? JSON.parse(String(options.body)) : null,
			};
			requests.push(request);
			const task = respond(request);
			active.add(task);
			void task.then(
				() => active.delete(task),
				() => active.delete(task),
			);
			return task;
		}),
	);
});
async function settled() {
	await waitFor(() =>
		expect(
			clients
				.flatMap((client) => client.getMutationCache().getAll())
				.some((mutation) => mutation.state.status === "pending"),
		).toBe(false),
	);
}
afterEach(async () => {
	try {
		gates.forEach((gate) => {
			gate.release();
		});
		await act(async () => {
			await Promise.allSettled([...active]);
		});
		await settled();
		receipts.push({
			test: expect.getState().currentTestName,
			requests,
			alerts,
			heldWorkJoined: active.size === 0,
		});
	} finally {
		toast.dismiss();
		cleanup();
		clients.forEach((client) => {
			client.clear();
		});
		vi.unstubAllGlobals();
	}
});
afterAll(() => {
	if (process.env.V4_EVIDENCE_ROOT)
		writeFileSync(
			join(process.env.V4_EVIDENCE_ROOT, "backup-management-requests.json"),
			JSON.stringify(receipts, null, 2),
		);
});
function show(ui: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	clients.push(client);
	return {
		client,
		...render(
			<QueryClientProvider client={client}>
				<ColorThemeProvider>
					<IncognitoProvider>
						{ui}
						<Toaster />
					</IncognitoProvider>
				</ColorThemeProvider>
			</QueryClientProvider>,
		),
	};
}

const backup = (id: string): BackupFileInfo => ({
	id,
	filename: `synthetic-${id}.arrb`,
	type: "manual",
	timestamp: "2026-10-25T12:00:00Z",
	size: 2048,
});
let backups: BackupFileInfo[];
let settings: BackupSettings;
let refused: boolean;
let gate: ReturnType<typeof hold> | null;
beforeEach(() => {
	backups = [backup("a")];
	settings = {
		id: 1,
		enabled: false,
		intervalType: "DISABLED",
		intervalValue: 24,
		retentionCount: 7,
		includeTrashBackups: false,
		lastRunAt: null,
		nextRunAt: null,
		createdAt: "2026-10-25T12:00:00Z",
		updatedAt: "2026-10-25T12:00:00Z",
	};
	refused = false;
	gate = null;
	respond = async ({ url, method, body }) => {
		if (method === "GET" && url === "/api/backup") return json({ backups });
		if (method === "GET" && url === "/api/backup/settings") return json(settings);
		if (gate) await gate.promise;
		if (refused) return json({ error: "Synthetic backup action refused" }, 503);
		if (method === "POST" && url === "/api/backup/create") {
			backups = [...backups, backup("b")];
			return json(backup("b"), 201);
		}
		if (method === "DELETE" && url === "/api/backup/b") {
			backups = [backup("a")];
			return json({ success: true, message: "Synthetic backup deleted" });
		}
		if (method === "PUT" && url === "/api/backup/settings") {
			settings = { ...settings, ...(body as object) };
			return json(settings);
		}
		throw new Error(`Unexpected request ${method} ${url}`);
	};
});
const management = () => (
	<>
		<BackupCreateCard />
		<BackupListSection />
		<BackupScheduleSection />
	</>
);
describe("S5 maintained backup nonrestore management", () => {
	it("creates once while held, reads current list, cancels delete then deletes exact selected B and reads A retained", async () => {
		show(management());
		await screen.findByText("synthetic-a.arrb");
		gate = hold();
		const create = screen.getByRole("button", { name: "Create Backup" });
		fireEvent.click(create);
		await waitFor(() => expect(writes()).toHaveLength(1));
		await waitFor(() => expect(create).toBeDisabled());
		fireEvent.click(create);
		await act(async () => {
			gate!.release();
		});
		gate = null;
		await screen.findByText("Backup created successfully!");
		await screen.findByText("synthetic-b.arrb");
		await settled();
		expect(writes()).toEqual([{ url: "/api/backup/create", method: "POST", body: {} }]);
		const item = within(screen.getByText("synthetic-b.arrb").closest("li")!);
		fireEvent.click(item.getByRole("button", { name: "Delete backup" }));
		expect(writes()).toHaveLength(1);
		vi.mocked(confirm).mockReturnValue(true);
		fireEvent.click(item.getByRole("button", { name: "Delete backup" }));
		await waitFor(() => expect(screen.queryByText("synthetic-b.arrb")).not.toBeInTheDocument());
		expect(screen.getByText("synthetic-a.arrb")).toBeInTheDocument();
		expect(writes()[1]).toEqual({ url: "/api/backup/b", method: "DELETE", body: null });
		expect(
			requests.filter((r) => r.url === "/api/backup" && r.method === "GET").length,
		).toBeGreaterThan(2);
	});
	it("retains refused schedule draft then explicitly saves hourly retention and reads it back on remount", async () => {
		const view = show(management());
		await screen.findByText("synthetic-a.arrb");
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "HOURLY" } });
		const [hours, retention] = screen.getAllByRole("spinbutton");
		fireEvent.change(hours!, { target: { value: "12" } });
		fireEvent.change(retention!, { target: { value: "3" } });
		refused = true;
		fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));
		await screen.findByText("Failed to save settings: Synthetic backup action refused");
		await settled();
		expect(hours).toHaveValue(12);
		expect(retention).toHaveValue(3);
		expect(writes()).toHaveLength(1);
		refused = false;
		fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));
		await screen.findByText("Settings saved successfully!");
		await settled();
		expect(writes()[1]).toEqual({
			url: "/api/backup/settings",
			method: "PUT",
			body: {
				enabled: true,
				intervalType: "HOURLY",
				intervalValue: 12,
				retentionCount: 3,
				includeTrashBackups: false,
			},
		});
		view.unmount();
		show(management());
		await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("HOURLY"));
		expect(screen.getAllByRole("spinbutton")[0]).toHaveValue(12);
		expect(screen.getAllByRole("spinbutton")[1]).toHaveValue(3);
	});
	it("keeps refused create and delete actionable without false success/list removal", async () => {
		refused = true;
		show(management());
		await screen.findByText("synthetic-a.arrb");
		fireEvent.click(screen.getByRole("button", { name: "Create Backup" }));
		await screen.findByText("Failed to create backup: Synthetic backup action refused");
		await settled();
		expect(screen.queryByText("Backup created successfully!")).not.toBeInTheDocument();
		// A different current backup B is selected for the refused delete.
		backups = [backup("a"), backup("b")];
		const view = clients[0]!;
		await act(async () => {
			await view.invalidateQueries({ queryKey: ["backups"] });
		});
		await screen.findByText("synthetic-b.arrb");
		vi.mocked(confirm).mockReturnValue(true);
		fireEvent.click(
			within(screen.getByText("synthetic-b.arrb").closest("li")!).getByRole("button", {
				name: "Delete backup",
			}),
		);
		await screen.findByText("Failed to delete backup: Synthetic backup action refused");
		await settled();
		expect(screen.getByText("synthetic-b.arrb")).toBeInTheDocument();
		expect(writes()).toEqual([
			{ url: "/api/backup/create", method: "POST", body: {} },
			{ url: "/api/backup/b", method: "DELETE", body: null },
		]);
	});
});
