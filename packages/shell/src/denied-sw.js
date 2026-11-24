// Served as /sw.js for a name the operator has stopped serving: deletes the origin's caches,
// removes the installed worker and reloads open pages, which then get the operator's notice.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.map((name) => caches.delete(name))))
      .catch(() => undefined)
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then((clients) => Promise.all(clients.map((client) => client.navigate(client.url).catch(() => undefined)))),
  );
});
