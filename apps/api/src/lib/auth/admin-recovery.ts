import { getPasswordSchema } from "@arr/shared";
import { openRestoreRuntime, type RestoreRuntime } from "../backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../backup/restore-runtime-client.js";
import { resolveSqliteRestoreStorage } from "../backup/restore-runtime-sqlite-storage.js";
import { hashPassword } from "./password.js";

export type AdministratorRecoveryResult = Readonly<{
	status: "success" | "refused" | "failed" | "uncertain" | "cancelled";
}>;
export interface AdministratorRecoveryInput {
	databaseUrl: string;
	username: string;
	password: string;
	confirmation: string;
	passwordPolicy: string;
	signal?: AbortSignal;
}
class RecoveryRefusal extends Error {}

/** No HTTP startup, bootstrap, migrations or raw second writer belongs in this operation. */
export async function recoverAdministratorPassword(
	input: AdministratorRecoveryInput,
): Promise<AdministratorRecoveryResult> {
	if (
		!["strict", "relaxed"].includes(input.passwordPolicy) ||
		!input.username ||
		input.username.length > 256 ||
		Array.from(input.username).some(
			(character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
		) ||
		input.password !== input.confirmation ||
		!getPasswordSchema(input.passwordPolicy as "strict" | "relaxed").safeParse(input.password)
			.success ||
		!/^(?:file:|postgres(?:ql)?:\/\/)/.test(input.databaseUrl)
	)
		return { status: "refused" };
	let runtime: Readonly<RestoreRuntime> | undefined;
	let lost = false;
	let mutationAttempted = false;
	let result: AdministratorRecoveryResult = { status: "failed" };
	const stop = () => runtime?.closeAdmission();
	input.signal?.addEventListener("abort", stop, { once: true });
	try {
		input.signal?.throwIfAborted();
		const databaseUrl = input.databaseUrl.startsWith("file:")
			? `file:${resolveSqliteRestoreStorage(input.databaseUrl).databasePath}`
			: input.databaseUrl;
		runtime = await openRestoreRuntime({
			databaseUrl,
			onUnavailable: () => {
				lost = true;
				stop();
			},
		});
		const native = createRuntimePrismaClient(runtime, { sqliteTransactionIntent: "write" });
		const selected = await runtime.runStarting(() =>
			native.prisma.user.findUnique({ where: { username: input.username } }),
		);
		if (!selected || selected.username !== input.username || !selected.hashedPassword)
			throw new RecoveryRefusal();
		const hashedPassword = await hashPassword(input.password);
		input.signal?.throwIfAborted();
		if (lost) throw new Error("Recovery unavailable");
		await runtime.runStarting(() =>
			native.prisma.$transaction(
				async (tx) => {
					input.signal?.throwIfAborted();
					if (lost) throw new Error("Recovery unavailable");
					const current = await tx.user.findUnique({ where: { username: input.username } });
					if (
						!current ||
						current.id !== selected.id ||
						current.username !== input.username ||
						!current.hashedPassword ||
						current.hashedPassword !== selected.hashedPassword
					)
						throw new RecoveryRefusal();
					input.signal?.throwIfAborted();
					if (lost) throw new Error("Recovery unavailable");
					mutationAttempted = true;
					const updated = await tx.user.updateMany({
						where: {
							id: current.id,
							username: input.username,
							hashedPassword: current.hashedPassword,
						},
						data: { hashedPassword, failedLoginAttempts: 0, lockedUntil: null },
					});
					if (updated.count !== 1) throw new RecoveryRefusal();
					await tx.session.deleteMany({ where: { userId: current.id } });
					input.signal?.throwIfAborted();
					if (lost) throw new Error("Recovery unavailable");
				},
				{ maxWait: 2000, timeout: 5000, isolationLevel: "Serializable" },
			),
		);
		result = { status: lost || input.signal?.aborted ? "uncertain" : "success" };
	} catch (error) {
		result = {
			status: mutationAttempted
				? "uncertain"
				: input.signal?.aborted
					? "cancelled"
					: error instanceof RecoveryRefusal
						? "refused"
						: "failed",
		};
	} finally {
		try {
			await runtime?.close();
		} catch {
			result = { status: mutationAttempted ? "uncertain" : "failed" };
		}
		input.signal?.removeEventListener("abort", stop);
	}
	return result.status === "success" && (lost || input.signal?.aborted)
		? { status: "uncertain" }
		: result;
}
