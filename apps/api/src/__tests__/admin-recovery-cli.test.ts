import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ recover: vi.fn() }));
vi.mock("../lib/auth/admin-recovery.js", () => ({
	recoverAdministratorPassword: boundary.recover,
}));

import { runAdminRecoveryCli } from "../reset-admin-password.js";

class Terminal extends PassThrough {
	isTTY = true;
	isRaw = false;
	rawModes: boolean[] = [];
	setRawMode(mode: boolean) {
		this.isRaw = mode;
		this.rawModes.push(mode);
		return this;
	}
}
function fixture() {
	const input = new Terminal();
	const output = new Terminal();
	const error = new PassThrough();
	const signals = new EventEmitter();
	let text = "";
	output.on("data", (chunk) => {
		text += chunk.toString();
	});
	error.on("data", (chunk) => {
		text += chunk.toString();
	});
	return { input, output, error, signals, text: () => text };
}
beforeEach(() => {
	vi.resetAllMocks();
	boundary.recover.mockResolvedValue({ status: "success" });
});
describe("hidden offline recovery terminal", () => {
	it("keeps identity/password/confirmation off output and restores terminal before mutation", async () => {
		const f = fixture();
		boundary.recover.mockImplementation(async () => {
			expect(f.input.isRaw).toBe(false);
			return { status: "success" };
		});
		const work = runAdminRecoveryCli({
			...f,
			argv: [],
			env: {
				DATABASE_URL: "postgresql://synthetic@127.0.0.1/private_test",
				PASSWORD_POLICY: "relaxed",
			},
		});
		await vi.waitFor(() => expect(f.text()).toContain("Exact username:"));
		f.input.write("SyntheticOwner\r");
		await vi.waitFor(() => expect(f.text()).toContain("New password:"));
		f.input.write("synthetic passphrase\r");
		await vi.waitFor(() => expect(f.text()).toContain("Confirm password:"));
		f.input.write("synthetic passphrase\r");
		expect(await work).toBe(0);
		expect(f.text()).not.toMatch(/SyntheticOwner|synthetic passphrase|private_test/);
		expect(f.input.rawModes).toEqual([true, false]);
		expect(boundary.recover).toHaveBeenCalledWith(
			expect.objectContaining({
				username: "SyntheticOwner",
				password: "synthetic passphrase",
				confirmation: "synthetic passphrase",
				passwordPolicy: "relaxed",
			}),
		);
		expect(f.input.listenerCount("data")).toBe(0);
		expect(f.signals.listenerCount("SIGINT")).toBe(0);
	});
	it.each(["eof", "ctrl-c", "signal"])(
		"refuses %s without a mutation and restores echo",
		async (mode) => {
			const f = fixture();
			const work = runAdminRecoveryCli({ ...f, argv: [], env: {} });
			await vi.waitFor(() => expect(f.text()).toContain("Exact username:"));
			if (mode === "eof") f.input.end();
			else if (mode === "ctrl-c") f.input.write("\u0003");
			else f.signals.emit("SIGTERM");
			expect(await work).toBe(1);
			expect(boundary.recover).not.toHaveBeenCalled();
			expect(f.input.isRaw).toBe(false);
			expect(f.input.listenerCount("data")).toBe(0);
		},
	);
	it("refuses non-TTY input and password arguments before reading or opening a database", async () => {
		const f = fixture();
		f.input.isTTY = false;
		expect(await runAdminRecoveryCli({ ...f, argv: [], env: {} })).toBe(1);
		f.input.isTTY = true;
		expect(await runAdminRecoveryCli({ ...f, argv: ["private-password-argument"], env: {} })).toBe(
			1,
		);
		expect(f.text()).not.toContain("private-password-argument");
		expect(boundary.recover).not.toHaveBeenCalled();
	});
	it("does not announce success for an uncertain mutation acknowledgement", async () => {
		const f = fixture();
		boundary.recover.mockResolvedValue({ status: "uncertain" });
		const work = runAdminRecoveryCli({ ...f, argv: [], env: {} });
		f.input.write("SyntheticOwner\rSynthetic-123!\rSynthetic-123!\r");
		expect(await work).toBe(1);
		expect(f.text()).toContain("Do not retry automatically");
		expect(f.text()).not.toContain("completed");
		expect(boundary.recover).toHaveBeenCalledOnce();
	});
});

describe("actual compiled command with an OS pseudo-terminal", () => {
	let directory: string;
	let actor: string;
	const api = resolve(import.meta.dirname, "../..");
	const require = createRequire(import.meta.url);
	const environment = {
		PATH: process.env.PATH,
		NODE_ENV: "test",
		DATABASE_URL: "unsupported://synthetic.invalid",
		PASSWORD_POLICY: "strict",
		LOG_DIR: "/dev/null/arr-recovery-tty",
		LOG_LEVEL: "fatal",
	};
	beforeAll(async () => {
		directory = mkdtempSync(join(tmpdir(), "arr-recovery-compiled-"));
		writeFileSync(join(directory, "package.json"), '{"type":"module"}', { mode: 0o600 });
		symlinkSync(join(api, "node_modules"), join(directory, "node_modules"));
		await promisify(execFile)(
			process.execPath,
			[
				join(dirname(require.resolve("tsup/package.json")), "dist/cli-default.js"),
				"src/reset-admin-password.ts",
				"--format",
				"esm",
				"--outDir",
				join(directory, "dist"),
			],
			{ cwd: api, env: environment, timeout: 60000, maxBuffer: 1024 * 1024 },
		);
		actor = join(directory, "dist/reset-admin-password.js");
	}, 60000);
	afterAll(() => {
		if (directory) rmSync(directory, { recursive: true, force: true });
	});
	it.each(["normal", "ctrl-c", "signal", "eof"])(
		"hides input and restores real terminal echo after %s",
		async (mode) => {
			// Python's standard-library PTY supplies actual kernel terminal behavior;
			// no credentials are sent in argv/environment/files. Its stdin is only the
			// private test controller; the compiled actor receives an actual TTY.
			const script = `import json,os,pty,select,signal,subprocess,sys,termios,time
control=json.load(sys.stdin)
master,slave=pty.openpty()
proc=None
def stop(signum,frame): raise SystemExit(1)
signal.signal(signal.SIGTERM,stop)
try:
 proc=subprocess.Popen([sys.argv[1],sys.argv[2]],stdin=slave,stdout=slave,stderr=slave,env=os.environ.copy())
 output=b''; sent=0; deadline=time.monotonic()+10
 prompts=[b'Exact username:',b'New password:',b'Confirm password:']
 while time.monotonic()<deadline:
  if select.select([master],[],[],0.05)[0]:
   try: output+=os.read(master,4096)
   except OSError: break
  if sent<3 and prompts[sent] in output:
   if control['mode']=='signal': proc.send_signal(signal.SIGTERM); sent=3
   elif control['mode']=='ctrl-c': os.write(master,b'\\x03'); sent=3
   elif control['mode']=='eof': os.write(master,b'\\x04'); sent=3
   else:
    value=control['username'] if sent==0 else control['password']
    os.write(master,value.encode()+b'\\r'); sent+=1
  if proc.poll() is not None: break
 if proc.poll() is None: raise RuntimeError('bounded terminal fixture timeout')
 while select.select([master],[],[],0)[0]:
  try: output+=os.read(master,4096)
  except OSError: break
 hidden=all(value.encode() not in output for value in [control['username'],control['password']])
 print(json.dumps({'exitCode':proc.returncode,'hidden':hidden,'echoRestored':bool(termios.tcgetattr(slave)[3]&termios.ECHO),'successReported':b'completed' in output}))
finally:
 if proc is not None and proc.poll() is None: proc.kill(); proc.wait()
 os.close(master); os.close(slave)
`;
			const result = await new Promise<string>((resolveResult, reject) => {
				const child = execFile(
					"python3",
					["-c", script, process.execPath, actor],
					{ env: environment, timeout: 20000, maxBuffer: 65536 },
					(error, stdout) => {
						if (error) reject(new Error("Synthetic OS terminal fixture did not complete"));
						else resolveResult(stdout);
					},
				);
				child.stdin!.end(
					JSON.stringify({
						mode,
						username: "SyntheticExactOwner",
						password: "Synthetic-Terminal-123!",
					}),
				);
			});
			expect(JSON.parse(result)).toEqual({
				exitCode: 1,
				hidden: true,
				echoRestored: true,
				successReported: false,
			});
		},
		25000,
	);
});

describe("development recovery configuration", () => {
	it("loads the source dotenv database, preserves exports and still reads the password from the terminal", async () => {
		const directory = mkdtempSync(join(tmpdir(), "arr-recovery-env-"));
		const selectedDatabase = `file:${join(directory, "selected.db")}`;
		const typedPassword = "Synthetic-Typed-123!";
		const f = fixture();
		const previousExitCode = process.exitCode;
		let work: Promise<number> | undefined;
		writeFileSync(
			join(directory, ".env"),
			`DATABASE_URL=${selectedDatabase}\nPASSWORD_POLICY=relaxed\nPASSWORD=Synthetic-File-Unused-123!\n`,
			{ mode: 0o600 },
		);
		vi.resetModules();
		vi.spyOn(process, "cwd").mockReturnValue(directory);
		vi.stubEnv("DATABASE_URL", undefined);
		vi.stubEnv("PASSWORD_POLICY", "strict");
		vi.stubEnv("PASSWORD", undefined);
		vi.stubEnv("DOTENV_CONFIG_PATH", undefined);
		vi.stubEnv("DOTENV_CONFIG_QUIET", "true");
		// Keep the real CLI/default process.env boundary and existing mock actor;
		// only supply the same isolated terminal used by the other CLI cases.
		vi.doMock("../reset-admin-password.js", () => ({
			runAdminRecoveryCli: () => {
				work = runAdminRecoveryCli({ ...f, argv: [] });
				return work;
			},
		}));
		try {
			await import("../../scripts/reset-admin-password.js");
			await vi.waitFor(() => expect(f.text()).toContain("Exact username:"));
			f.input.write(`SyntheticConfigOwner\r${typedPassword}\r${typedPassword}\r`);
			expect(await work).toBe(0);
			expect(boundary.recover).toHaveBeenCalledWith(
				expect.objectContaining({
					databaseUrl: selectedDatabase,
					passwordPolicy: "strict",
					username: "SyntheticConfigOwner",
					password: typedPassword,
					confirmation: typedPassword,
				}),
			);
			expect(f.text()).not.toContain(typedPassword);
			expect(f.text()).not.toContain(selectedDatabase);
		} finally {
			f.signals.emit("SIGTERM");
			await work;
			vi.doUnmock("../reset-admin-password.js");
			vi.restoreAllMocks();
			vi.unstubAllEnvs();
			process.exitCode = previousExitCode;
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
