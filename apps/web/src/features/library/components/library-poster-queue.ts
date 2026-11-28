const MAX_ACTIVE_POSTERS = 8;

interface PosterRequest {
	image: HTMLImageElement;
	url: string;
	active: boolean;
}

const requests = new Map<HTMLImageElement, PosterRequest>();
const waiting = new Set<PosterRequest>();
let observer: IntersectionObserver | undefined;
let active = 0;

function admitWaitingPosters() {
	for (const request of waiting) {
		if (active >= MAX_ACTIVE_POSTERS) break;
		waiting.delete(request);
		request.active = true;
		active++;
		request.image.loading = "eager";
		request.image.src = request.url;
	}
}

/** Keep offscreen images out of the queue and start nearby images in arrival order. */
export function observeLibraryPoster(image: HTMLImageElement, url: string) {
	observer ??= new IntersectionObserver(
		(entries, source) => {
			if (source !== observer) return;
			for (const entry of entries) {
				const request = requests.get(entry.target as HTMLImageElement);
				if (!request) continue;
				if (entry.isIntersecting) {
					if (!request.active) waiting.add(request);
				} else {
					waiting.delete(request);
					// Yield to the new viewport. The same poster can rejoin on reentry.
					if (request.active && !request.image.complete) {
						request.image.removeAttribute("src");
						request.active = false;
						active--;
					}
				}
			}
			admitWaitingPosters();
		},
		{ rootMargin: "160px 0px" },
	);
	const current = observer;
	const request: PosterRequest = { image, url, active: false };
	requests.set(image, request);
	current.observe(image);

	return () => {
		if (requests.get(image) !== request) return;
		requests.delete(image);
		current.unobserve(image);
		waiting.delete(request);
		if (request.active) active--;
		if (requests.size === 0) {
			current.disconnect();
			observer = undefined;
		}
		admitWaitingPosters();
	};
}
