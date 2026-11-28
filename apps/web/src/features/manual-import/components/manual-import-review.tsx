"use client";

import { useState } from "react";
import type { ManualImportModalProps, ManualImportReviewSource } from "../types";
import { ManualImportModal } from "./manual-import-modal";

type Props = Pick<ManualImportModalProps, "open" | "onOpenChange" | "onCompleted"> & {
	sources: readonly ManualImportReviewSource[];
};

export const ManualImportReview = ({ sources, ...props }: Props) => {
	const [position, setPosition] = useState<{ sources: Props["sources"]; index: number } | null>(
		null,
	);
	const index = position?.sources === sources ? Math.min(position.index, sources.length - 1) : 0;
	const source = sources[index];
	if (!source) return null;
	return (
		<ManualImportModal
			{...source}
			{...props}
			reviewNavigation={
				sources.length > 1
					? {
							position: index + 1,
							total: sources.length,
							onPrevious: index > 0 ? () => setPosition({ sources, index: index - 1 }) : undefined,
							onNext:
								index < sources.length - 1
									? () => setPosition({ sources, index: index + 1 })
									: undefined,
						}
					: undefined
			}
		/>
	);
};

export default ManualImportReview;
