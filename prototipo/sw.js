/* Service worker do Posto Legal (PWA). Rede primeiro: com internet o app sempre pega a versão publicada;
   sem internet, abre com a última cópia guardada. Só arquivos do próprio site; Supabase, mapa e fontes
   passam direto. Troque VERSAO quando mudar a lista do CASCA. */
const VERSAO="posto-legal-v1",CASCA=["./","index.html","regras.js","manifest.webmanifest","icone.svg","icones/icone-192.png","icones/icone-512.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(VERSAO).then(c=>c.addAll(CASCA)).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==VERSAO).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{
  const r=e.request;
  if(r.method!=="GET"||new URL(r.url).origin!==self.location.origin)return;
  e.respondWith(fetch(r).then(resp=>{
    if(resp.ok){const copia=resp.clone();caches.open(VERSAO).then(c=>c.put(r,copia))}
    return resp;
  }).catch(()=>caches.match(r).then(c=>c||(r.mode==="navigate"?caches.match("index.html"):Response.error()))));
});
