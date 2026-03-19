/* eslint-disable no-restricted-globals */

/**
 * Service worker for browser push notifications.
 *
 * Receives push events from the web-push library and displays
 * native OS notifications via the Notifications API.
 */

self.addEventListener("push", (event) => {
	if (!event.data) return;

	let data;
	try {
		data = event.data.json();
	} catch {
		data = { title: "Notification", body: event.data.text() };
	}

	const title = data.title || "arr-dashboard";
	const options = {
		body: data.body || "",
		icon: "/icon-192.png",
		badge: "/icon-192.png",
		data: { url: data.url },
	};

	event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();

	const url = event.notification.data?.url || "/";
	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
			for (const client of clientList) {
				if (client.url.includes(url) && "focus" in client) {
					return client.focus();
				}
			}
			if (self.clients.openWindow) {
				return self.clients.openWindow(url);
			}
		}),
	);
});
