import type { EmailConfig } from "@arr/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ createTransport: vi.fn() }));
vi.mock("nodemailer", () => ({ default: { createTransport: boundary.createTransport } }));

import { closeAllTransports, emailSender } from "../email-sender.js";

const original: EmailConfig = {
	host: "smtp.example.test",
	port: 587,
	secure: false,
	user: "synthetic-user",
	password: "synthetic-original-password",
	from: "sender@example.test",
	to: "recipient@example.test",
};
const payload = { eventType: "HUNT_COMPLETED" as const, title: "Synthetic", body: "Fixture" };

type TransportOptions = {
	host: string;
	port: number;
	secure: boolean;
	auth: { user: string; pass: string };
};
type Mail = { from: string; to: string; subject: string };
type Connection = {
	options: TransportOptions;
	closed: boolean;
	close: ReturnType<typeof vi.fn>;
	messages: Mail[];
	deliver: (mail: Mail) => Promise<void>;
};
let connections: Connection[];
let expected: EmailConfig;

beforeEach(() => {
	closeAllTransports();
	connections = [];
	expected = original;
	boundary.createTransport.mockReset().mockImplementation((options: TransportOptions) => {
		const connection: Connection = {
			options,
			closed: false,
			close: vi.fn(() => {
				connection.closed = true;
			}),
			messages: [],
			deliver: async () => {},
		};
		connections.push(connection);
		return {
			close: connection.close,
			sendMail: async (mail: Mail) => {
				if (
					connection.closed ||
					options.auth.pass !== expected.password ||
					options.secure !== expected.secure
				) {
					throw Object.assign(new Error("synthetic authentication rejected"), { code: "EAUTH" });
				}
				connection.messages.push(mail);
				await connection.deliver(mail);
				return { messageId: "synthetic-message" };
			},
		};
	});
});
afterEach(() => closeAllTransports());

function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

describe("SMTP transport config rotation", () => {
	it.each([
		{ field: "password", change: { password: "synthetic-replaced-password" } },
		{ field: "TLS", change: { secure: true } },
	])("send then Test adopts changed $field without a process restart", async ({ change }) => {
		expect((await emailSender.send(original, payload)).success).toBe(true);
		expected = { ...original, ...change };
		await expect(emailSender.test(expected)).resolves.toBeUndefined();
		expect(connections).toHaveLength(2);
		expect(connections[0]?.closed).toBe(true);
	});

	it.each([
		{ field: "password", change: { password: "synthetic-replaced-password" } },
		{ field: "TLS", change: { secure: true } },
	])("Test then send adopts changed $field without a process restart", async ({ change }) => {
		await emailSender.test(original);
		expected = { ...original, ...change };
		expect(await emailSender.send(expected, payload)).toEqual({ success: true, retryable: false });
		expect(connections).toHaveLength(2);
	});

	it("unchanged connection config reuses pooling while from/to changes reach the message", async () => {
		await emailSender.test(original);
		const changed = {
			...original,
			from: "new-sender@example.test",
			to: "new-recipient@example.test",
		};
		expect((await emailSender.send(changed, payload)).success).toBe(true);
		expect(connections).toHaveLength(1);
		expect(connections[0]?.messages).toEqual([
			expect.objectContaining({ from: original.from, to: original.to }),
			expect.objectContaining({ from: changed.from, to: changed.to }),
		]);
	});

	it("rotation keeps two accepted sends alive until both settle, then closes the retired pool", async () => {
		await emailSender.test(original);
		const first = deferred();
		const second = deferred();
		let calls = 0;
		connections[0]!.deliver = () => (++calls === 1 ? first.promise : second.promise);
		const pendingFirst = emailSender.send(original, payload);
		const pendingSecond = emailSender.send(original, payload);
		expected = { ...original, password: "synthetic-rotated" };
		await emailSender.test(expected);
		expect(connections[0]?.closed).toBe(false);
		first.resolve();
		expect((await pendingFirst).success).toBe(true);
		expect(connections[0]?.closed).toBe(false);
		second.resolve();
		expect((await pendingSecond).success).toBe(true);
		expect(connections[0]?.closed).toBe(true);
		expect(connections[0]?.close).toHaveBeenCalledOnce();
	});

	it.each(["send", "test"] as const)(
		"a retired %s failure releases its pool without exposing provider text",
		async (operation) => {
			await emailSender.test(original);
			const delivery = deferred();
			connections[0]!.deliver = () => delivery.promise;
			const pending =
				operation === "send" ? emailSender.send(original, payload) : emailSender.test(original);
			const observed = pending.then(
				(result) => ({ result }),
				(error: unknown) => ({ error }),
			);
			expected = { ...original, secure: true };
			await emailSender.test(expected);
			expect(connections[0]?.closed).toBe(false);
			delivery.reject(
				Object.assign(new Error("synthetic-private-provider-text"), { code: "ETIMEDOUT" }),
			);
			const outcome = await observed;
			if (operation === "send") {
				expect(outcome).toMatchObject({
					result: { success: false, retryable: true, failureCategory: "timeout" },
				});
			} else {
				expect(outcome).toMatchObject({ error: { category: "timeout" } });
			}
			expect(JSON.stringify(outcome)).not.toContain("synthetic-private-provider-text");
			expect(connections[0]?.close).toHaveBeenCalledOnce();
		},
	);

	it("replacement construction failure does not retire the existing valid pool", async () => {
		await emailSender.test(original);
		boundary.createTransport.mockImplementationOnce(() => {
			throw new Error("synthetic-create-failure");
		});
		expected = { ...original, password: "synthetic-new" };
		expect((await emailSender.send(expected, payload)).success).toBe(false);
		expect(connections[0]?.closed).toBe(false);
		expected = original;
		expect((await emailSender.send(original, payload)).success).toBe(true);
		expect(connections).toHaveLength(1);
	});

	it("shutdown closes current and retired transports once, even when accepted work later settles", async () => {
		await emailSender.test(original);
		const delivery = deferred();
		connections[0]!.deliver = () => delivery.promise;
		const pending = emailSender.send(original, payload);
		expected = { ...original, password: "synthetic-new" };
		await emailSender.test(expected);
		closeAllTransports();
		closeAllTransports();
		expect(connections).toHaveLength(2);
		expect(connections.every((connection) => connection.closed)).toBe(true);
		delivery.resolve();
		await pending;
		for (const connection of connections) expect(connection.close).toHaveBeenCalledOnce();
	});
});
