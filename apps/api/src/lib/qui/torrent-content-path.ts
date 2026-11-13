import type { QuiTorrent } from "@arr/shared";

const providerContentPath = Symbol("qui-provider-content-path");

/** Keep qUI's private filesystem path available to server-side diagnostics only. */
export function attachProviderContentPath<T extends QuiTorrent>(torrent: T, path?: string): T {
	if (path) {
		Object.defineProperty(torrent, providerContentPath, {
			value: path,
			configurable: false,
			enumerable: false,
			writable: false,
		});
	}
	return torrent;
}

export function readProviderContentPath(torrent: QuiTorrent): string | undefined {
	return (torrent as QuiTorrent & { [providerContentPath]?: string })[providerContentPath];
}
