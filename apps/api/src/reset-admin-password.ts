import type { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { recoverAdministratorPassword } from "./lib/auth/admin-recovery.js";

interface RecoveryInput extends Pick<EventEmitter, "on" | "off"> {
	isTTY?: boolean;
	isRaw?: boolean;
	setRawMode(mode: boolean): unknown;
	resume(): unknown;
	pause(): unknown;
}
interface RecoveryOutput {
	isTTY?: boolean;
	write(text: string): unknown;
}
interface RecoveryTerminalOptions {
	input?: RecoveryInput;
	output?: RecoveryOutput;
	error?: Pick<RecoveryOutput, "write">;
	signals?: Pick<EventEmitter, "on" | "off">;
	argv?: string[];
	env?: Partial<Pick<NodeJS.ProcessEnv, "DATABASE_URL" | "PASSWORD_POLICY">>;
}

/** One raw terminal reader; secret input is never echoed or placed on an argument list. */
async function readCredentials(input: RecoveryInput, output: RecoveryOutput, signal: AbortSignal) {
	const originalRaw = input.isRaw ?? false;
	const decoder = new StringDecoder("utf8");
	const lines: string[] = [];
	let current = "";
	let skipLf = false;
	let failure = false;
	let wake: (() => void) | undefined;
	const fail = () => {
		failure = true;
		wake?.();
	};
	const data = (chunk: Buffer | string) => {
		for (const char of typeof chunk === "string" ? chunk : decoder.write(chunk)) {
			if (skipLf && char === "\n") {
				skipLf = false;
				continue;
			}
			skipLf = false;
			if (char === "\r" || char === "\n") {
				lines.push(current);
				current = "";
				skipLf = char === "\r";
				wake?.();
				if (lines.length > 3) fail();
			} else if (char === "\b" || char === "\x7f")
				current = Array.from(current).slice(0, -1).join("");
			else if (char.charCodeAt(0) < 0x20 || current.length >= 256) {
				fail();
				break;
			} else current += char;
		}
	};
	const line = async (prompt: string) => {
		output.write(prompt);
		while (!lines.length && !failure && !signal.aborted)
			await new Promise<void>((done) => {
				wake = done;
			});
		wake = undefined;
		if (failure || signal.aborted) throw new Error("Recovery input unavailable");
		output.write("\n");
		return lines.shift()!;
	};
	try {
		input.setRawMode(true);
		input.on("data", data);
		input.on("end", fail);
		input.on("error", fail);
		signal.addEventListener("abort", fail, { once: true });
		input.resume();
		const username = await line("Exact username: ");
		const password = await line("New password: ");
		const confirmation = await line("Confirm password: ");
		return { username, password, confirmation };
	} finally {
		input.off("data", data);
		input.off("end", fail);
		input.off("error", fail);
		signal.removeEventListener("abort", fail);
		current = "";
		lines.length = 0;
		input.setRawMode(originalRaw);
		input.pause();
	}
}

export async function runAdminRecoveryCli(options: RecoveryTerminalOptions = {}): Promise<number> {
	const input = options.input ?? process.stdin;
	const output = options.output ?? process.stdout;
	const error = options.error ?? process.stderr;
	const signals = options.signals ?? process;
	const argv = options.argv ?? process.argv.slice(2);
	const env = options.env ?? process.env;
	if (argv.length || !input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
		error.write("Recovery requires an interactive terminal and accepts no arguments.\n");
		return 1;
	}
	const controller = new AbortController();
	const cancel = () => controller.abort();
	signals.on("SIGINT", cancel);
	signals.on("SIGTERM", cancel);
	try {
		const credentials = await readCredentials(input, output, controller.signal);
		const result = await recoverAdministratorPassword({
			...credentials,
			databaseUrl: env.DATABASE_URL || "file:/config/prod.db",
			passwordPolicy: env.PASSWORD_POLICY ?? "strict",
			signal: controller.signal,
		});
		if (result.status === "success") {
			output.write("Password recovery completed. Restart the normal service.\n");
			return 0;
		}
		error.write(
			result.status === "uncertain"
				? "Recovery outcome is unconfirmed. Do not retry automatically; verify through normal sign-in.\n"
				: "Recovery refused or unavailable. No successful recovery was confirmed.\n",
		);
		return 1;
	} catch {
		error.write("Recovery cancelled or unavailable. No successful recovery was confirmed.\n");
		return 1;
	} finally {
		signals.off("SIGINT", cancel);
		signals.off("SIGTERM", cancel);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	void runAdminRecoveryCli()
		.then((code) => {
			process.exitCode = code;
		})
		.catch(() => {
			process.exitCode = 1;
		});
}
