// Grid — offline shell. Bump CACHE on every deploy or phones keep the old app.
const CACHE = "grid-v5";
const ASSETS = ["./", "./index.html", "./manifest.webmanifest", "./icon-180.png", "./icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Cache-first, then revalidate in the background.
 *
 * The app shell is a single file that rarely changes, so the old network-first
 * order made every launch wait on a round trip to prove nothing had changed.
 * Now the cached copy paints immediately and the network refreshes it for next
 * time. A deploy therefore lands one launch later, which is the trade PLAN_V2
 * §6 asks for — bumping CACHE above is what makes it land at all.
 *
 * Only same-origin GETs are touched. The Worker's /state call is cross-origin
 * and must stay network-only (it's the one thing that has to be fresh), and
 * it's the sync PUT besides, so both fall through untouched.
 */
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req)
        .then(res => {
          // Only ever store a real success. The previous version cached
          // whatever came back, so a 404 or a 500 became the offline copy.
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached || caches.match("./index.html"));

      // Cached copy wins the race; the fetch above still runs to refresh it.
      return cached || network;
    })
  );
});

self.addEventListener("push", e => {
  let data = { title: "Grid", body: "" };
  try{ data = e.data.json(); }catch(err){}
  e.waitUntil(self.registration.showNotification(data.title || "Grid", {
    body: data.body || "",
    icon: "./icon-180.png",
    badge: "./icon-180.png"
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window" }).then(clients => {
      for(const c of clients){ if("focus" in c) return c.focus(); }
      return self.clients.openWindow("./index.html");
    })
  );
});
