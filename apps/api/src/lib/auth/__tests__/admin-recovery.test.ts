import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ open: vi.fn(), create: vi.fn(), hash: vi.fn() }));
vi.mock("../../backup/restore-runtime-admission.js", () => ({ openRestoreRuntime: boundary.open }));
vi.mock("../../backup/restore-runtime-client.js", () => ({
	createRuntimePrismaClient: boundary.create,
}));
vi.mock("../password.js", () => ({ hashPassword: boundary.hash }));

import { recoverAdministratorPassword } from "../admin-recovery.js";

const input = {
	databaseUrl: "postgresql://synthetic@127.0.0.1/synthetic_test",
	username: "Owner",
	password: "Synthetic-New-123!",
	confirmation: "Synthetic-New-123!",
	passwordPolicy: "strict",
};
let user: { id: string; username: string; hashedPassword: string | null };
let runtime: {
	runStarting: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
	closeAdmission: ReturnType<typeof vi.fn>;
};
let transaction: ReturnType<typeof vi.fn>;
let update: ReturnType<typeof vi.fn>;
let removeSessions: ReturnType<typeof vi.fn>;
let lookup: ReturnType<typeof vi.fn>;
let initialLookup: ReturnType<typeof vi.fn>;
beforeEach(() => {
	vi.resetAllMocks();
	user = { id: "selected", username: "Owner", hashedPassword: "old-synthetic-hash" };
	lookup = vi.fn(async () => ({ ...user }));
	initialLookup = vi.fn(async () => ({ ...user }));
	update = vi.fn(async () => ({ count: 1 }));
	removeSessions = vi.fn(async () => ({ count: 2 }));
	transaction = vi.fn(async (work) =>
		work({
			user: { findUnique: lookup, updateMany: update },
			session: { deleteMany: removeSessions },
		}),
	);
	runtime = {
		runStarting: vi.fn(async (work) => work()),
		close: vi.fn(async () => {}),
		closeAdmission: vi.fn(),
	};
	boundary.open.mockResolvedValue(runtime);
	boundary.create.mockReturnValue({
		prisma: { user: { findUnique: initialLookup }, $transaction: transaction },
	});
	boundary.hash.mockResolvedValue("new-synthetic-hash");
});

describe("offline administrator recovery boundary", () => {
	it("re-resolves the exact local account and changes only its password, lockout and sessions", async () => {
		expect(await recoverAdministratorPassword(input)).toEqual({ status: "success" });
		expect(boundary.create).toHaveBeenCalledWith(runtime, { sqliteTransactionIntent: "write" });
		expect(initialLookup).toHaveBeenCalledWith({ where: { username: "Owner" } });
		expect(lookup).toHaveBeenCalledWith({ where: { username: "Owner" } });
		expect(update).toHaveBeenCalledWith({
			where: { id: "selected", username: "Owner", hashedPassword: "old-synthetic-hash" },
			data: { hashedPassword: "new-synthetic-hash", failedLoginAttempts: 0, lockedUntil: null },
		});
		expect(removeSessions).toHaveBeenCalledWith({ where: { userId: "selected" } });
		expect(boundary.hash.mock.invocationCallOrder[0]).toBeLessThan(
			transaction.mock.invocationCallOrder[0]!,
		);
		expect(runtime.close).toHaveBeenCalledOnce();
	});
	it.each(["owner", "OWNER", "Owner "])(
		"refuses inexact account %s without a write",
		async (username) => {
			expect(await recoverAdministratorPassword({ ...input, username })).toEqual({
				status: "refused",
			});
			expect(transaction).not.toHaveBeenCalled();
			expect(runtime.close).toHaveBeenCalledOnce();
		},
	);
	it("refuses a passwordless account without adding a new authentication method", async () => {
		user.hashedPassword = null;
		expect(await recoverAdministratorPassword(input)).toEqual({ status: "refused" });
		expect(boundary.hash).not.toHaveBeenCalled();
		expect(transaction).not.toHaveBeenCalled();
	});
	it("refuses a changed target inside the transaction", async () => {
		lookup.mockResolvedValue({ ...user, id: "collision-peer" });
		expect(await recoverAdministratorPassword(input)).toEqual({ status: "refused" });
		expect(update).not.toHaveBeenCalled();
		expect(removeSessions).not.toHaveBeenCalled();
	});
	it.each([
		{ passwordPolicy: "invalid" },
		{ passwordPolicy: "" },
		{ password: "short", confirmation: "short" },
		{ password: "x".repeat(129), confirmation: "x".repeat(129), passwordPolicy: "relaxed" },
		{ password: "lowercaseonly", confirmation: "lowercaseonly" },
		{ confirmation: "different-value" },
		{ username: "" },
		{ databaseUrl: "mysql://synthetic.invalid/db" },
	])("rejects invalid input before opening a database %#", async (fields) => {
		expect(await recoverAdministratorPassword({ ...input, ...fields })).toEqual({
			status: "refused",
		});
		expect(boundary.open).not.toHaveBeenCalled();
	});
	it("honors relaxed policy and its shared 128-character maximum", async () => {
		const password = "x".repeat(128);
		expect(
			await recoverAdministratorPassword({
				...input,
				password,
				confirmation: password,
				passwordPolicy: "relaxed",
			}),
		).toEqual({ status: "success" });
	});
	it("refuses an occupied or suspended native owner without a second writer", async () => {
		boundary.open.mockRejectedValue(new Error("synthetic-private-url-and-identity"));
		expect(await recoverAdministratorPassword(input)).toEqual({ status: "failed" });
		expect(boundary.create).not.toHaveBeenCalled();
	});
	it("closes admission on owner loss and does not enter a transaction", async () => {
		boundary.hash.mockImplementation(async () => {
			boundary.open.mock.calls[0]![0].onUnavailable();
			return "new-synthetic-hash";
		});
		expect(await recoverAdministratorPassword(input)).toEqual({ status: "failed" });
		expect(runtime.closeAdmission).toHaveBeenCalledOnce();
		expect(transaction).not.toHaveBeenCalled();
	});
	it("never retries a transaction with an uncertain acknowledgement", async () => {
		transaction.mockImplementation(async (work) => {
			await work({
				user: { findUnique: lookup, updateMany: update },
				session: { deleteMany: removeSessions },
			});
			throw new Error("synthetic-private-ack-error");
		});
		expect(await recoverAdministratorPassword(input)).toEqual({ status: "uncertain" });
		expect(transaction).toHaveBeenCalledOnce();
		expect(update).toHaveBeenCalledOnce();
		expect(runtime.close).toHaveBeenCalledOnce();
	});
	it("joins physical closure before returning success and refuses uncertain closure", async () => {
		let release!: () => void;
		runtime.close.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const work = recoverAdministratorPassword(input);
		await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledOnce());
		let settled = false;
		void work.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		release();
		expect(await work).toEqual({ status: "success" });
		runtime.close.mockRejectedValue(new Error("synthetic-private-close-error"));
		expect(await recoverAdministratorPassword(input)).toEqual({ status: "uncertain" });
	});
	it("cancels before mutation while still joining resources", async () => {
		const controller = new AbortController();
		boundary.hash.mockImplementation(async () => {
			controller.abort();
			return "new-synthetic-hash";
		});
		expect(await recoverAdministratorPassword({ ...input, signal: controller.signal })).toEqual({
			status: "cancelled",
		});
		expect(transaction).not.toHaveBeenCalled();
		expect(runtime.close).toHaveBeenCalledOnce();
	});
	it("reports an interrupted close as uncertain after committing, without replay", async () => {
		const controller = new AbortController();
		let release!: () => void;
		runtime.close.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const work = recoverAdministratorPassword({ ...input, signal: controller.signal });
		await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledOnce());
		controller.abort();
		release();
		expect(await work).toEqual({ status: "uncertain" });
		expect(transaction).toHaveBeenCalledOnce();
	});
});
