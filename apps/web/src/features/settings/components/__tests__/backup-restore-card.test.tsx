import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthGate } from "../../../../components/auth/auth-gate";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import * as backupHooks from "../../../../hooks/api/useBackup";
import {
	acknowledgeProtectedUnauthorized,
	getPendingUnauthorizedRevision,
} from "../../../../lib/auth-session-signal";
import { useIncognitoMode } from "../../../../lib/incognito";
import { authKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { BackupRestoreCard } from "../backup-restore-card";
import { BackupTab } from "../backup-tab";

const navigation = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("next/navigation", () => ({
	usePathname: () => "/settings",
	useRouter: () => ({ push: (path: string) => navigation.paths.push(path) }),
}));
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
function response(payload: unknown, status = 200) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
function CachedView() {
	const query = useQuery({
		queryKey: ["synthetic-library"],
		staleTime: Infinity,
		queryFn: async () => ({ value: "synthetic-server-data" }),
	});
	return <p>{query.data?.value}</p>;
}
function IncognitoControl() {
	const [, setIncognito] = useIncognitoMode();
	return (
		<button type="button" onClick={() => setIncognito(true)}>
			Enable incognito
		</button>
	);
}
function show(props: { id?: string; clear?: () => void; gate?: boolean; tab?: boolean } = {}) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: 2, retryDelay: 0 } },
	});
	clients.push(client);
	client.setQueryData(authKeys.currentUser, { id: "synthetic-old-account" });
	client.setQueryData(authKeys.setupRequired, { required: false });
	client.setQueryData(["synthetic-library"], { value: "synthetic-old-cache" });
	const card = props.tab ? (
		<BackupTab />
	) : (
		<BackupRestoreCard selectedBackupId={props.id} onSelectionClear={props.clear} />
	);
	return {
		client,
		...render(
			<QueryClientProvider client={client}>
				<ColorThemeProvider>
					<IncognitoProvider>
						{props.tab ? <IncognitoControl /> : null}
						{props.gate ? (
							<AuthGate>
								<CachedView />
								{card}
							</AuthGate>
						) : (
							card
						)}
					</IncognitoProvider>
				</ColorThemeProvider>
			</QueryClientProvider>,
		),
	};
}
function selectUpload(
	file = new File(["{}"], "synthetic-backup.json", { type: "application/json" }),
) {
	fireEvent.change(screen.getByLabelText("Encrypted backup file"), { target: { files: [file] } });
}
function confirm() {
	fireEvent.click(
		screen.getByRole("checkbox", { name: /replace accounts, settings, and end all sessions/i }),
	);
}
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	backupHooks.clearRestoreHandoff?.();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	acknowledgeProtectedUnauthorized(getPendingUnauthorizedRevision());
	navigation.paths.length = 0;
	window.localStorage.removeItem("arr-dashboard-incognito-mode");
});

it("requires an explicit destructive-account/session confirmation before submission", () => {
	show();
	expect(screen.getByText(/accounts and settings will be replaced/i)).toBeInTheDocument();
	expect(screen.getByText(/sign in with restored accounts after restart/i)).toBeInTheDocument();
	selectUpload();
	expect(screen.getByRole("button", { name: "Restore backup" })).toBeDisabled();
	confirm();
	expect(screen.getByRole("button", { name: "Restore backup" })).toBeEnabled();
});

describe.each(["upload", "stored"] as const)("real %s Restore form", (selection) => {
	it("sends only selected input once, clears the password and does not offer an ordinary terminal retry", async () => {
		let posts = 0;
		const cleared = vi.fn();
		vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
			posts++;
			expect(url).toBe(
				selection === "upload" ? "/api/backup/restore" : "/api/backup/restore-from-file",
			);
			expect(JSON.parse(options.body as string)).toEqual(
				selection === "upload"
					? { backupData: "e30=", password: "synthetic-password" }
					: { id: "a".repeat(24), password: "synthetic-password" },
			);
			return response(refused, 409);
		});
		const { client } = show({
			id: selection === "stored" ? "a".repeat(24) : undefined,
			clear: cleared,
		});
		if (selection === "upload") selectUpload();
		else expect(screen.getByText("Stored backup selected")).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Backup password (optional)"), {
			target: { value: "synthetic-password" },
		});
		confirm();
		fireEvent.click(screen.getByRole("button", { name: "Restore backup" }));
		await screen.findByText(/restore was not committed/i);
		expect(screen.getByText(/completely stop and start arr dashboard/i)).toBeInTheDocument();
		expect(screen.getByLabelText("Backup password (optional)")).toHaveValue("");
		expect(screen.getByRole("button", { name: "Restore backup" })).toBeDisabled();
		expect(screen.queryByRole("button", { name: /retry restore/i })).not.toBeInTheDocument();
		expect(posts).toBe(1);
		expect(cleared).toHaveBeenCalled();
		await waitFor(() => expect(client.getMutationCache().getAll()).toHaveLength(0));
	});
});

it("keeps request-in-progress truthful and prevents duplicate submits while the response is held", async () => {
	let release!: (value: Response) => void,
		posts = 0;
	vi.stubGlobal("fetch", () => {
		posts++;
		return new Promise<Response>((resolve) => {
			release = resolve;
		});
	});
	show();
	selectUpload();
	confirm();
	const submit = screen.getByRole("button", { name: "Restore backup" });
	fireEvent.click(submit);
	await screen.findByText(/restore request in progress/i);
	expect(screen.getByText(/closing this window does not cancel/i)).toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Restoring…" })).toBeDisabled();
	try {
		await waitFor(() => expect(posts).toBe(1));
		fireEvent.submit(submit.closest("form")!);
		expect(posts).toBe(1);
	} finally {
		await act(async () => release(response(refused, 409)));
	}
	await screen.findByText(/restore was not committed/i);
});

it("permits form correction after a verified pre-publication refusal without automatically repeating it", async () => {
	let posts = 0;
	vi.stubGlobal("fetch", async () => {
		posts++;
		return response({ error: "Restore request rejected", category: "invalid-backup" }, 400);
	});
	show();
	selectUpload();
	confirm();
	fireEvent.click(screen.getByRole("button", { name: "Restore backup" }));
	await screen.findByText(/backup or password was rejected before publication/i);
	expect(screen.getByRole("button", { name: "Restore backup" })).toBeDisabled();
	selectUpload();
	confirm();
	expect(screen.getByRole("button", { name: "Restore backup" })).toBeEnabled();
	expect(posts).toBe(1);
});

it("shows rate-limit wait/reselect guidance without ending the account session or replaying", async () => {
	let posts = 0;
	vi.stubGlobal("fetch", async (_url: string, options: RequestInit) => {
		if (options.method !== "POST")
			return response({ id: "synthetic-old-account", required: false });
		posts++;
		return response(
			{
				error: "Restore request rejected",
				category: "restore-rate-limited",
				retryAfterSeconds: 300,
			},
			429,
		);
	});
	const { client } = show({ gate: true });
	selectUpload();
	fireEvent.change(screen.getByLabelText("Backup password (optional)"), {
		target: { value: "synthetic-password" },
	});
	confirm();
	fireEvent.click(screen.getByRole("button", { name: "Restore backup" }));
	await screen.findByText(/restore request was rate limited before publication/i);
	expect(screen.getByRole("alert")).toHaveTextContent(/wait up to 300 seconds/i);
	expect(screen.getByText("synthetic-old-cache")).toBeInTheDocument();
	expect(client.getQueryData(authKeys.currentUser)).not.toBeNull();
	expect(getPendingUnauthorizedRevision()).toBe(0);
	expect(screen.getByLabelText("Backup password (optional)")).toHaveValue("");
	expect(screen.getByRole("checkbox", { name: /replace accounts/i })).not.toBeChecked();
	expect(screen.getByRole("button", { name: "Restore backup" })).toBeDisabled();
	expect(screen.queryByRole("button", { name: "Check recovered status" })).not.toBeInTheDocument();
	selectUpload();
	expect(screen.getByRole("button", { name: "Restore backup" })).toBeDisabled();
	confirm();
	expect(screen.getByRole("button", { name: "Restore backup" })).toBeEnabled();
	expect(posts).toBe(1);
});

it("refuses an actual oversized file before sending a restore", async () => {
	let posts = 0;
	vi.stubGlobal("fetch", async () => {
		posts++;
		return response(committed);
	});
	show();
	selectUpload(new File([new Uint8Array(39321601)], "synthetic-oversized.json"));
	confirm();
	fireEvent.click(screen.getByRole("button", { name: "Restore backup" }));
	await screen.findByText(/exceeds the 50 miB encoded upload limit/i);
	expect(posts).toBe(0);
});

it.each([
	[200, committed],
	[503, unavailable],
	[0, null],
] as const)(
	"quarantines the actual AuthGate/cache at outcome %i and keeps only bounded recovery state across remount",
	async (status, payload) => {
		let posts = 0;
		vi.stubGlobal("fetch", async (url: string) => {
			if (url === "/auth/setup-required") return response({ required: false });
			if (url === "/auth/me") return response({ error: "Unauthorized" }, 401);
			posts++;
			if (status === 0) throw new Error("synthetic-private-transport");
			return response(payload, status);
		});
		const { client, unmount } = show({ gate: true });
		expect(screen.getByText("synthetic-old-cache")).toBeInTheDocument();
		selectUpload();
		confirm();
		fireEvent.click(screen.getByRole("button", { name: "Restore backup" }));
		await waitFor(() => expect(screen.queryByText("synthetic-old-cache")).not.toBeInTheDocument());
		expect(client.getQueryData(["synthetic-library"])).toBeUndefined();
		expect(client.getQueryData(authKeys.currentUser)).toBeNull();
		unmount();
		show();
		if (status === 200) await screen.findByText(/restore committed/i);
		else await screen.findByText(/may have committed|may already have committed/i);
		expect(screen.getByRole("button", { name: "Restore backup" })).toBeDisabled();
		expect(screen.queryByText(/synthetic-private-transport/)).not.toBeInTheDocument();
		expect(posts).toBe(1);
	},
);

it.each(["matching", "different", "absent", "unavailable"] as const)(
	"checks %s recovered status without replay or claiming rollback",
	async (evidence) => {
		let posts = 0,
			gets = 0;
		vi.stubGlobal("fetch", async (_url: string, options: RequestInit) => {
			if (options.method === "POST") {
				posts++;
				return response(refused, 409);
			}
			gets++;
			return evidence === "unavailable"
				? response({ error: "Unavailable" }, 503)
				: response({
						latestCommitted:
							evidence === "absent"
								? null
								: {
										restoreId:
											evidence === "matching" ? restoreId : "050f0253-25ca-4b44-90f3-7d24b2ccad85",
										committedAt: "2026-10-09T10:00:00.000Z",
									},
					});
		});
		show();
		selectUpload();
		confirm();
		fireEvent.click(screen.getByRole("button", { name: "Restore backup" }));
		await screen.findByText(/restore was not committed/i);
		fireEvent.click(screen.getByRole("button", { name: "Check recovered status" }));
		if (evidence === "matching") await screen.findByText(/matching committed restore confirmed/i);
		else if (evidence === "unavailable")
			await screen.findByText(/recovered status could not be verified/i);
		else await screen.findByText(/does not establish rollback/i);
		expect(posts).toBe(1);
		expect(gets).toBe(1);
		const clear = screen.queryByRole("button", { name: "Clear recovery notice" });
		if (evidence === "unavailable") expect(clear).not.toBeInTheDocument();
		else {
			expect(clear).toBeEnabled();
			fireEvent.click(clear!);
			expect(screen.getByRole("button", { name: "Restore backup" })).toBeDisabled();
		}
	},
);

it("allows a new explicitly selected and confirmed request only after a fresh protected recovery check", async () => {
	let posts = 0,
		gets = 0;
	vi.stubGlobal("fetch", async (_url: string, options: RequestInit) => {
		if (options.method === "POST") {
			posts++;
			return response(refused, 409);
		}
		gets++;
		return response({ latestCommitted: null });
	});
	show();
	selectUpload();
	confirm();
	fireEvent.click(screen.getByRole("button", { name: "Restore backup" }));
	await screen.findByText(/restore was not committed/i);
	expect(screen.queryByRole("button", { name: "Clear recovery notice" })).not.toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Check recovered status" }));
	await screen.findByText(/does not establish rollback/i);
	fireEvent.click(screen.getByRole("button", { name: "Clear recovery notice" }));
	expect(posts).toBe(1);
	expect(gets).toBe(1);
	expect(screen.getByRole("button", { name: "Restore backup" })).toBeDisabled();
	selectUpload();
	confirm();
	fireEvent.click(screen.getByRole("button", { name: "Restore backup" }));
	await screen.findByText(/restore was not committed/i);
	expect(posts).toBe(2);
});

it("does not permit a remounted form to publish again while the original request is still pending", async () => {
	let posts = 0;
	let release!: (value: Response) => void;
	vi.stubGlobal("fetch", () => {
		posts++;
		return new Promise<Response>((resolve) => {
			release = resolve;
		});
	});
	const { unmount } = show();
	selectUpload();
	confirm();
	fireEvent.click(screen.getByRole("button", { name: "Restore backup" }));
	await screen.findByText(/restore request in progress/i);
	await waitFor(() => expect(posts).toBe(1));
	unmount();
	show();
	try {
		expect(screen.getByLabelText("Encrypted backup file")).toBeDisabled();
		expect(screen.getByRole("button", { name: /restoring|restore backup/i })).toBeDisabled();
		expect(posts).toBe(1);
	} finally {
		await act(async () => release(response(refused, 409)));
	}
	await screen.findByText(/restore was not committed/i);
	expect(posts).toBe(1);
});

const storedBackup = {
	id: "a".repeat(24),
	filename: "synthetic-private-backup.json",
	type: "manual",
	timestamp: "2026-10-09T10:00:00.000Z",
	size: 2048,
};
function backupReadResponse(url: string) {
	if (url === "/api/backup") return response({ backups: [storedBackup] });
	if (url === "/api/backup/password/status")
		return response({ configured: true, source: "database" });
	if (url === "/api/backup/settings")
		return response({
			enabled: false,
			intervalType: "DISABLED",
			intervalValue: 24,
			retentionCount: 7,
			includeTrashBackups: false,
		});
	throw new Error(`Unexpected synthetic read route: ${url}`);
}

it("retains stored rate-limit guidance across selection clearing and requires fresh confirmation", async () => {
	let posts = 0;
	vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
		if (options.method !== "POST") return backupReadResponse(url);
		posts++;
		expect(url).toBe("/api/backup/restore-from-file");
		return response(
			{
				error: "Restore request rejected",
				category: "restore-rate-limited",
				retryAfterSeconds: 300,
			},
			429,
		);
	});
	const { client } = show({ tab: true, gate: true });
	const select = await screen.findByRole("button", { name: "Select backup for restore" });
	fireEvent.click(select);
	fireEvent.change(screen.getByLabelText("Backup password (optional)"), {
		target: { value: "synthetic-password" },
	});
	confirm();
	fireEvent.click(screen.getByRole("button", { name: "Restore backup" }));
	await screen.findByRole("alert");
	expect(screen.getByRole("alert")).toHaveTextContent(/wait up to 300 seconds/i);
	expect(screen.queryByText("Stored backup selected")).not.toBeInTheDocument();
	expect(screen.getByLabelText("Encrypted backup file")).toHaveValue("");
	expect(screen.getByLabelText("Backup password (optional)")).toHaveValue("");
	expect(screen.getByRole("checkbox", { name: /replace accounts/i })).not.toBeChecked();
	expect(screen.getByRole("button", { name: "Restore backup" })).toBeDisabled();
	expect(screen.getByText("synthetic-old-cache")).toBeInTheDocument();
	expect(client.getQueryData(authKeys.currentUser)).not.toBeNull();
	expect(getPendingUnauthorizedRevision()).toBe(0);
	expect(screen.queryByRole("button", { name: "Check recovered status" })).not.toBeInTheDocument();
	await waitFor(() => expect(screen.getByRole("button", { name: "Create Backup" })).toBeEnabled());
	fireEvent.click(screen.getByRole("button", { name: "Select backup for restore" }));
	expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	expect(screen.getByLabelText("Backup password (optional)")).toHaveValue("");
	expect(screen.getByRole("checkbox", { name: /replace accounts/i })).not.toBeChecked();
	expect(screen.getByRole("button", { name: "Restore backup" })).toBeDisabled();
	confirm();
	expect(screen.getByRole("button", { name: "Restore backup" })).toBeEnabled();
	expect(posts).toBe(1);
});

it("selects a stored row without publishing and locks other Backup controls through recovery", async () => {
	let posts = 0;
	let release!: (value: Response) => void;
	vi.stubGlobal("fetch", (url: string, options: RequestInit) => {
		if (options.method !== "POST") return Promise.resolve(backupReadResponse(url));
		posts++;
		expect(url).toBe("/api/backup/restore-from-file");
		expect(JSON.parse(options.body as string)).toEqual({ id: "a".repeat(24) });
		return new Promise<Response>((resolve) => {
			release = resolve;
		});
	});
	show({ tab: true });
	const select = await screen.findByRole("button", { name: "Select backup for restore" });
	expect(screen.getByRole("button", { name: "Create Backup" })).toBeEnabled();
	expect(screen.getByRole("button", { name: "Download backup" })).toBeEnabled();
	fireEvent.click(select);
	expect(screen.getByText("Stored backup selected")).toBeInTheDocument();
	expect(screen.queryByLabelText("Encrypted backup file")).not.toBeInTheDocument();
	expect(posts).toBe(0);
	confirm();
	fireEvent.click(screen.getByRole("button", { name: "Restore backup" }));
	await waitFor(() => expect(posts).toBe(1));
	try {
		expect(screen.getByRole("button", { name: "Create Backup" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Download backup" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Select backup for restore" })).toBeDisabled();
	} finally {
		await act(async () => release(response(refused, 409)));
	}
	await screen.findByText(/restore was not committed/i);
	expect(screen.getByLabelText("Encrypted backup file")).toHaveValue("");
	expect(screen.getByRole("button", { name: "Create Backup" })).toBeDisabled();
	expect(screen.getByRole("button", { name: "Check recovered status" })).toBeEnabled();
	expect(posts).toBe(1);
});

it("masks the stored backup filename in incognito without changing restore selection", async () => {
	let posts = 0;
	vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
		if (options.method === "POST") posts++;
		return backupReadResponse(url);
	});
	show({ tab: true });
	await screen.findByText(storedBackup.filename);
	fireEvent.click(screen.getByRole("button", { name: "Enable incognito" }));
	expect(screen.queryByText(storedBackup.filename)).not.toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Select backup for restore" }));
	expect(screen.getByText("Stored backup selected")).toBeInTheDocument();
	expect(posts).toBe(0);
});

it("shows a bounded stored-list error without exposing private provider diagnostics", async () => {
	vi.stubGlobal("fetch", async (url: string) =>
		url === "/api/backup"
			? response({ message: "synthetic-private-path-and-credentials" }, 503)
			: backupReadResponse(url),
	);
	show({ tab: true });
	await screen.findByText(/failed to load backups/i);
	expect(screen.queryByText(/synthetic-private-path-and-credentials/)).not.toBeInTheDocument();
	expect(
		screen.queryByRole("button", { name: "Select backup for restore" }),
	).not.toBeInTheDocument();
});
