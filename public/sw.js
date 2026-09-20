// --- 1. AD NETWORK CODE (तुम्हारी कमाई वाला कोड) ---
self.options = {
    "domain": "3nbf4.com",
    "zoneId": 11847695
}
self.lary = ""
importScripts('https://3nbf4.com/act/files/service-worker.min.js?r=sw')

// --- 2. SUKOON PWA CODE (तुम्हारा पुराना ऐप वाला कोड) ---
const CACHE_NAME = "sukoon-app-v1";
const urlsToCache = ["/", "/index.html", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(urlsToCache)));
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => response || fetch(event.request))
  );
});
