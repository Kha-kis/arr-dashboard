"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { lookup } = require("node:dns/promises");
const { isIP } = require("node:net");
const { networkInterfaces } = require("node:os");

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

function canonicalIp(address) {
	if (isIP(address) === 4) return address;
	if (isIP(address) === 6) return new URL(`http://[${address}]`).hostname.slice(1, -1);
	throw new Error("Invalid local address");
}

function localBindTarget(value) {
	const address = canonicalIp(value);
	if (address === "0.0.0.0") return "127.0.0.1";
	if (address === "::") return "::1";
	if (address.startsWith("127.") || address === "::1") return address;
	const local = Object.values(networkInterfaces())
		.flat()
		.some((entry) => entry && canonicalIp(entry.address) === address);
	if (!local) throw new Error("Invalid local address");
	return address;
}

async function resolveLocalBindTarget(value) {
	const address = isIP(value) ? value : (await lookup(value)).address;
	return localBindTarget(address);
}

function origin(port, target) {
	return `http://${isIP(target) === 6 ? `[${target}]` : target}:${port}`;
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
	const metadata = target === undefined ? `${port}\n` : `${port}\n${localBindTarget(target)}\n`;
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

function readWebOrigin(directory) {
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
			state.size > 46
		) {
			throw new Error("Invalid runtime metadata");
		}
		const buffer = Buffer.alloc(47);
		const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
		const value = buffer.subarray(0, length).toString("utf8");
		if (length !== state.size || !value.endsWith("\n")) throw new Error("Invalid runtime metadata");
		const fields = value.slice(0, -1).split("\n");
		if (fields.length !== 1 && fields.length !== 2) throw new Error("Invalid runtime metadata");
		const port = parsePort(fields[0]);
		const target = fields.length === 2 ? localBindTarget(fields[1]) : "127.0.0.1";
		return origin(port, target);
	} finally {
		fs.closeSync(descriptor);
	}
}

async function checkWebHealth(directory = runtimeDirectory) {
	try {
		const base = readWebOrigin(directory);
		const response = await fetch(`${base}/live`, {
			redirect: "manual",
			// Web /live already permits an 8s API response. Stay above that
			// budget and below the image's unchanged 10s Docker timeout.
			signal: AbortSignal.timeout(9000),
		});
		const healthy = response.status === 200;
		await response.body?.cancel();
		return healthy;
	} catch {
		return false;
	}
}

module.exports = { publishWebPort, checkWebHealth };

if (require.main === module) {
	const [command, port, host] = process.argv.slice(2);
	if ((command === "publish" || command === "target") && process.argv.length === 5) {
		resolveLocalBindTarget(host)
			.then((target) => {
				if (command === "publish") publishWebPort(port, runtimeDirectory, target);
				else process.stdout.write(origin(parsePort(port), target));
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
