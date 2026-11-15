// Téléchargement des rues depuis Overpass.
// Les serveurs publics sont souvent lents ou saturés : on les interroge en décalé
// (un nouveau toutes les quelques secondes), le premier qui répond gagne, les autres sont annulés.
// Le résultat est gardé en cache dans le navigateur (Cache API) pendant 14 jours.

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const STAGGER_MS = 4000;
const TIMEOUT_MS = 60000;
const CACHE_NAME = 'rundraw-osm-v1';
const CACHE_DAYS = 14;

export function streetsQuery(s, w, n, e) {
  return `[out:json][timeout:50];
way["highway"]["highway"!~"^(motorway|motorway_link|trunk|trunk_link|construction|proposed|raceway|bus_guideway|escape|abandoned|platform|corridor|elevator|busway|via_ferrata)$"]["access"!~"^(private|no)$"]["foot"!~"^(no|private)$"]["service"!~"^(parking_aisle|driveway|drive-through)$"]["area"!="yes"](${s},${w},${n},${e});
(._;>;);
out skel qt;`;
}

const cacheKey = (key) => `https://rundraw.cache/osm/${key}`;

async function readCache(key) {
  try {
    const c = await caches.open(CACHE_NAME);
    const r = await c.match(cacheKey(key));
    if (!r) return null;
    const age = Date.now() - Number(r.headers.get('x-saved') || 0);
    if (age > CACHE_DAYS * 864e5) return null;
    return await r.text();
  } catch { return null; }
}
async function writeCache(key, text) {
  try {
    const c = await caches.open(CACHE_NAME);
    await c.put(cacheKey(key), new Response(text, { headers: { 'x-saved': String(Date.now()) } }));
  } catch { /* cache indisponible : pas grave */ }
}

async function readWithProgress(resp, signal, onProgress) {
  if (!resp.body || !resp.body.getReader) return resp.text();
  const reader = resp.body.getReader();
  const chunks = [];
  let bytes = 0;
  for (;;) {
    if (signal.aborted) throw new DOMException('Annulé', 'AbortError');
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    bytes += value.length;
    onProgress?.(bytes);
  }
  const all = new Uint8Array(bytes);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return new TextDecoder().decode(all);
}

/**
 * Renvoie le JSON Overpass (texte) pour la bbox.
 * onStatus({ phase: 'cache'|'waiting'|'download', servers, bytes })
 */
export async function fetchStreets([s, w, n, e], { signal, onStatus } = {}) {
  const key = [s, w, n, e].map((v) => v.toFixed(4)).join(',');
  const cached = await readCache(key);
  if (cached) { onStatus?.({ phase: 'cache' }); return { key, text: cached }; }

  const body = 'data=' + encodeURIComponent(streetsQuery(s, w, n, e));
  const controllers = [];
  const abortAll = () => controllers.forEach((c) => c.abort());
  signal?.addEventListener('abort', abortAll);

  try {
    const text = await new Promise((resolve, reject) => {
      let started = 0, failed = 0, winner = null, nextTimer = null;
      const errors = [];
      const fail = () => {
        if (failed >= ENDPOINTS.length) reject(new Error('Serveurs OpenStreetMap indisponibles (' + errors.join(', ') + '). Réessaie dans une minute.'));
      };
      const launch = () => {
        clearTimeout(nextTimer);
        if (winner || signal?.aborted || started >= ENDPOINTS.length) return;
        const i = started++;
        onStatus?.({ phase: 'waiting', servers: started });
        const ctrl = new AbortController();
        controllers.push(ctrl);
        const kill = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        // Si ce serveur tarde, on en lance un autre en parallèle.
        nextTimer = setTimeout(launch, STAGGER_MS);
        fetch(ENDPOINTS[i], {
          method: 'POST', body, signal: ctrl.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })
          .then(async (r) => {
            if (!r.ok) throw new Error(r.status === 429 ? 'trop de requêtes' : 'HTTP ' + r.status);
            if (winner) return;
            // Premier serveur qui répond : on annule les autres et on n'en lance plus.
            winner = ctrl;
            clearTimeout(nextTimer);
            controllers.forEach((c) => c !== ctrl && c.abort());
            const t = await readWithProgress(r, ctrl.signal, (bytes) => onStatus?.({ phase: 'download', bytes }));
            clearTimeout(kill);
            if (!t.trimStart().startsWith('{')) throw new Error('réponse invalide');
            resolve(t);
          })
          .catch((err) => {
            clearTimeout(kill);
            if (signal?.aborted) return reject(new DOMException('Annulé', 'AbortError'));
            if (winner && winner !== ctrl) return; // serveur perdant annulé : normal
            if (winner === ctrl) return reject(err); // le gagnant a échoué en cours de téléchargement
            errors.push(err.name === 'AbortError' ? 'délai dépassé' : err.message);
            failed++;
            fail();
            launch(); // échec rapide : on passe tout de suite au serveur suivant
          });
      };
      launch();
    });
    writeCache(key, text);
    return { key, text };
  } finally {
    signal?.removeEventListener('abort', abortAll);
  }
}
