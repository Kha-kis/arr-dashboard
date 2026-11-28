"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { lookup } = require("node:dns/promises");
const { isIP } = require("node:net");
const { get } = require("node:http");
const { localSocketTarget, socketOrigin } = fs.existsSync(
	path.join(__dirname, "docker-socket-target.cjs"),
)
	? require("./docker-socket-target.cjs")
	: require("../apps/web/docker-socket-target.cjs");

// Ephemeral container state, not database/configuration or readiness evidence.
const runtimeDirectory = "/tmp/arr-dashboard-runtime-health";

function parsePort(value) {
	if (typeof value !== "string" || !/^[1-9][0-9]{0,4}$/.test(value)) {
		throw new Error("Invalid runtime port");
	}
	const port = Number(value);
	if (!Number.isSafeInteger(port) || port > 65535) throw new Error("Invalid runtime port");
	return port;
}

async function resolveLocalBindTarget(value) {
	const address = isIP(value) ? value : (await lookup(value)).address;
	return localSocketTarget(address);
}

function directoryOwner(directory, publishing) {
	const state = fs.lstatSync(directory);
	const uid = process.getuid();
	if (
		!state.isDirectory() ||
		(state.mode & 0o777) !== 0o700 ||
		(state.uid !== uid && (publishing || uid !== 0))
	) {
		throw new Error("Invalid runtime directory");
	}
	return state.uid;
}

function publishWebPort(value, directory = runtimeDirectory, target) {
	const port = parsePort(value);
	const metadata = target === undefined ? `${port}\n` : `${port}\n${localSocketTarget(target)}\n`;
	try {
		fs.mkdirSync(directory, { mode: 0o700 });
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	}
	directoryOwner(directory, true);
	const temporary = path.join(directory, `.web-port-${randomUUID()}`);
	let created = false;
	let descriptor;
	try {
		descriptor = fs.openSync(
			temporary,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
			0o600,
		);
		created = true;
		fs.writeFileSync(descriptor, metadata);
		fs.closeSync(descriptor);
		descriptor = undefined;
		fs.renameSync(temporary, path.join(directory, "web-port"));
		created = false;
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
		if (created) fs.unlinkSync(temporary);
	}
}

function readWebSocket(directory) {
	const owner = directoryOwner(directory, false);
	const descriptor = fs.openSync(
		path.join(directory, "web-port"),
		fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
	);
	try {
		const state = fs.fstatSync(descriptor);
		if (
			!state.isFile() ||
			state.uid !== owner ||
			(state.mode & 0o777) !== 0o600 ||
			state.size < 2 ||
			state.size > 81
		) {
			throw new Error("Invalid runtime metadata");
		}
		const buffer = Buffer.alloc(82);
		const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
		const value = buffer.subarray(0, length).toString("utf8");
		if (length !== state.size || !value.endsWith("\n")) throw new Error("Invalid runtime metadata");
		const fields = value.slice(0, -1).split("\n");
		if (fields.length !== 1 && fields.length !== 2) throw new Error("Invalid runtime metadata");
		const port = parsePort(fields[0]);
		const hostname = fields.length === 2 ? localSocketTarget(fields[1]) : "127.0.0.1";
		return { port, hostname };
	} finally {
		fs.closeSync(descriptor);
	}
}

async function checkWebHealth(directory = runtimeDirectory) {
	try {
		const { hostname, port } = readWebSocket(directory);
		return await new Promise((resolve) => {
			const request = get(
				{
					hostname,
					port,
					path: "/live",
					headers: { host: new URL(socketOrigin(port, hostname)).host },
					// Web allows an 8s API response. Stay below the Docker probe timeout.
					signal: AbortSignal.timeout(9000),
				},
				(response) => {
					response.destroy();
					resolve(response.statusCode === 200);
				},
			);
			request.once("error", () => resolve(false));
		});
	} catch {
		return false;
	}
}

module.exports = { publishWebPort, checkWebHealth };

if (require.main === module) {
	const [command, webPort, apiPort, host] = process.argv.slice(2);
	if (command === "handoff" && process.argv.length === 6) {
		resolveLocalBindTarget(host)
			.then((target) => {
				const apiOrigin = socketOrigin(parsePort(apiPort), target);
				publishWebPort(webPort, runtimeDirectory, target);
				const literal = host.split("%")[0];
				if (
					host.includes("%") &&
					["::", "::ffff:0:0"].includes(new URL(`http://[${literal}]`).hostname.slice(1, -1))
				) {
					process.stderr.write(
						"WARNING: An interface scope does not restrict a wildcard HOST. Use ::1 or 127.0.0.1 for loopback-only access.\n",
					);
				}
				process.stdout.write(`${apiOrigin}\t${target}`);
			})
			.catch(() => {
				process.stderr.write("ERROR: Runtime listener metadata unavailable\n");
				process.exitCode = 1;
			});
	} else if (command === "check" && process.argv.length === 3) {
		checkWebHealth().then((healthy) => {
			process.exitCode = healthy ? 0 : 1;
		});
	} else {
		process.exitCode = 1;
	}
}
