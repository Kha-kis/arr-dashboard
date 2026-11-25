"use strict";

const { readdirSync, readFileSync } = require("node:fs");
const { isIP } = require("node:net");
const { networkInterfaces } = require("node:os");

function canonicalIp(address) {
	if (isIP(address) === 4) return address;
	if (isIP(address) !== 6 || address.includes("%")) throw new Error("Invalid local address");
	const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1);
	const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
	if (!mapped) return canonical;
	const high = Number.parseInt(mapped[1], 16);
	const low = Number.parseInt(mapped[2], 16);
	return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

function localInterface(scope) {
	const names = readdirSync("/sys/class/net");
	if (/^[0-9]+$/.test(scope)) {
		return names.find(
			(name) => Number(readFileSync(`/sys/class/net/${name}/ifindex`, "utf8")) === Number(scope),
		);
	}
	return names.find((name) => name === scope);
}

function localSocketTarget(value) {
	if (!isIP(value)) throw new Error("Invalid local address");
	const [literal, scope] = value.split("%");
	const address = canonicalIp(literal);
	const interfaceName = scope === undefined ? undefined : localInterface(scope);
	if (scope !== undefined && !interfaceName) throw new Error("Invalid local interface scope");

	if (address === "0.0.0.0") return "127.0.0.1";
	if (address === "::") return "::1";
	if (address.startsWith("127.") || address === "::1") return address;

	const interfaces = networkInterfaces();
	const candidates = interfaceName ? interfaces[interfaceName] : Object.values(interfaces).flat();
	if (!candidates?.some((entry) => entry && canonicalIp(entry.address.split("%")[0]) === address))
		throw new Error("Invalid local address");
	// An IPv6 link-local address needs an explicit interface to select its socket.
	if (isIP(address) === 6 && /^fe[89ab][a-f0-9]:/i.test(address) && !scope)
		throw new Error("Link-local listener requires an interface scope");
	return scope !== undefined && isIP(address) === 6 ? `${address}%${scope}` : address;
}

function socketOrigin(port, host) {
	const address = host.split("%")[0];
	return `http://${isIP(address) === 6 ? `[${address}]` : address}:${port}`;
}

function dockerIPv6ApiSocket(hostname, configuredOrigin) {
	if (!hostname || isIP(hostname) === 4) return;
	if (isIP(hostname) !== 6 || localSocketTarget(hostname) !== hostname)
		throw new Error("Invalid internal IPv6 API target");
	const origin = new URL(configuredOrigin);
	const port = origin.port || "80";
	if (
		origin.href !== `${origin.origin}/` ||
		origin.origin !== new URL(socketOrigin(port, hostname)).origin
	)
		throw new Error("Internal IPv6 API origin does not match the socket target");
	return { hostname, origin, port };
}

module.exports = { localSocketTarget, socketOrigin, dockerIPv6ApiSocket };
