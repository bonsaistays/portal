// Bonsai Stays — Service Worker
const CACHE = 'bonsai-app-v6';
const PRECACHE = [
  '/app/',
  '/app/index.html',
  '/app/manifest.json',
  '/PhotosLogos/Bonsa Stays.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  // Network first for API calls, cache first for assets
  if (e.request.url.includes('supabase') || e.request.url.includes('open-meteo')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
  } else {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      if (res.status === 200) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    })));
  }
});

// Push notifications
self.addEventListener('push', e => {
  const data = e.data?.json() || { title: 'Bonsai Stays', body: 'You have a new notification' };
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: '/PhotosLogos/Bonsa Stays.png',
    badge: '/PhotosLogos/Bonsa Stays.png',
    data: data.url || '/app/',
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data || '/app/'));
});
