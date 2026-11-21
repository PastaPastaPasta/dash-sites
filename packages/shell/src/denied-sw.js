// Served as /sw.js for a name the operator has stopped serving: removes the installed worker
// and reloads open pages, which then get the operator's notice from the server.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    self.registration
      .unregister()
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then((clients) => Promise.all(clients.map((client) => client.navigate(client.url).catch(() => undefined)))),
  );
});
