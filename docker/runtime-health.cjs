"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

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

function publishWebPort(value, directory = runtimeDirectory) {
	const port = parsePort(value);
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
		fs.writeFileSync(descriptor, `${port}\n`);
		fs.closeSync(descriptor);
		descriptor = undefined;
		fs.renameSync(temporary, path.join(directory, "web-port"));
		created = false;
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
		if (created) fs.unlinkSync(temporary);
	}
}

function readWebPort(directory) {
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
			state.size > 6
		) {
			throw new Error("Invalid runtime metadata");
		}
		const buffer = Buffer.alloc(7);
		const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
		const value = buffer.subarray(0, length).toString("utf8");
		const port = parsePort(value.slice(0, -1));
		if (length !== state.size || value !== `${port}\n`) {
			throw new Error("Invalid runtime metadata");
		}
		return port;
	} finally {
		fs.closeSync(descriptor);
	}
}

async function checkWebHealth(directory = runtimeDirectory) {
	try {
		const port = readWebPort(directory);
		const response = await fetch(`http://127.0.0.1:${port}/live`, {
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
	if (process.argv[2] === "publish" && process.argv.length === 4) {
		try {
			publishWebPort(process.argv[3]);
		} catch {
			process.stderr.write("ERROR: Runtime health metadata unavailable\n");
			process.exitCode = 1;
		}
	} else if (process.argv[2] === "check" && process.argv.length === 3) {
		checkWebHealth().then((healthy) => {
			process.exitCode = healthy ? 0 : 1;
		});
	} else {
		process.exitCode = 1;
	}
}
