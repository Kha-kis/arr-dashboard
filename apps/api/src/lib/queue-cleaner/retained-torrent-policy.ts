export const RETAINED_TORRENT_BLOCKLIST_ERROR =
	"Retaining and recategorizing a torrent requires blocklisting the exact release";

type RetainedTorrentPolicy = {
	removeFromClient: boolean;
	addToBlocklist: boolean;
	changeCategoryEnabled: boolean;
};

export function isUnsafeRetainedTorrentPolicy(policy: RetainedTorrentPolicy): boolean {
	return !policy.removeFromClient && policy.changeCategoryEnabled && !policy.addToBlocklist;
}
