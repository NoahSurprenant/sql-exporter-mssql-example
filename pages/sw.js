// Stands in for Grafana's backend: answers its API calls from recording.json, the responses a real
// Grafana gave while showing the snapshot. Everything else (the app's own files) passes through.
const BASE = new URL(self.registration.scope).pathname;
let recording;
const load = async () => (recording ??= await (await fetch(BASE + "recording.json")).json());

self.addEventListener("install", (e) => { e.waitUntil(load()); self.skipWaiting(); });
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (!["api/", "apis/", "avatar/"].some((p) => url.pathname.startsWith(BASE + p))) return;
  e.respondWith((async () => {
    const r = await load();
    const key = `${e.request.method} /${url.pathname.slice(BASE.length)}`;
    const hit = r[key + url.search] ?? r[key] ??
      Object.entries(r).find(([k]) => k.split("?")[0] === key)?.[1];
    if (hit) return new Response(hit.body, { status: hit.status, headers: { "Content-Type": hit.type } });
    // Not recorded: an empty success, so a panel or menu shows nothing rather than an error.
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  })());
});
