let nextRevision = 0;
let pendingRevision = 0;
const listeners = new Set<() => void>();

function notifyListeners(): void {
	for (const listener of listeners) listener();
}

export function reportProtectedUnauthorized(): void {
	if (pendingRevision !== 0) return;
	pendingRevision = ++nextRevision;
	notifyListeners();
}

export function acknowledgeProtectedUnauthorized(revision: number): void {
	if (pendingRevision !== revision) return;
	pendingRevision = 0;
	notifyListeners();
}

export function getPendingUnauthorizedRevision(): number {
	return pendingRevision;
}

export function subscribeProtectedUnauthorized(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
