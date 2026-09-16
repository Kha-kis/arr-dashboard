export type LabelSyncMutationAdmission = {
	readonly isOpen: () => boolean;
};

// Manual, scheduled and event-driven writers share the application's Prisma
// instance. Binding recovery admission here keeps every entry point closed
// until inherited claims have been classified, including direct writer calls.
const admissions = new WeakMap<object, LabelSyncMutationAdmission>();

export function registerLabelSyncMutationAdmission(
	prisma: object,
	admission: LabelSyncMutationAdmission,
): () => void {
	if (admissions.has(prisma)) throw new Error("Mutation admission already registered");
	admissions.set(prisma, admission);
	return () => {
		if (admissions.get(prisma) === admission) admissions.delete(prisma);
	};
}

export function isLabelSyncMutationAdmitted(prisma: object): boolean {
	return admissions.get(prisma)?.isOpen() === true;
}
