/* TireCalc test service worker — v13
   Test repository only. Do not copy to the production repository until verified.
*/
const CACHE = 'tirecalc-shared-v13';
const CACHE_PREFIX = 'tirecalc-shared-v';
const CONTROL_CACHE = 'tirecalc-control-v2';
const CONTROL_KEY = './__tirecalc_control__';

const FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

const DEFAULT_STATE = {
  active: CACHE,
  previous: null,
  lastGood: null,
  candidate: CACHE,
  rollbackAvailable: false
};

async function readState() {
  try {
    const cache = await caches.open(CONTROL_CACHE);
    const response = await cache.match(CONTROL_KEY);
    if (response) {
      return { ...DEFAULT_STATE, ...(await response.json()) };
    }
  } catch (_) {}
  return { ...DEFAULT_STATE };
}

async function writeState(state) {
  const cache = await caches.open(CONTROL_CACHE);
  await cache.put(
    CONTROL_KEY,
    new Response(JSON.stringify(state), {
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

async function cacheIsComplete(cacheName) {
  try {
    const cache = await caches.open(cacheName);
    const entries = await Promise.all(
      FILES.map((file) => cache.match(file))
    );
    return entries.every(Boolean);
  } catch (_) {
    return false;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(FILES);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();

    const candidates = names
      .filter((name) =>
        name.startsWith(CACHE_PREFIX) && name !== CACHE
      )
      .sort()
      .reverse();

    let previous = null;

    for (const name of candidates) {
      if (await cacheIsComplete(name)) {
        previous = name;
        break;
      }
    }

    const oldState = await readState();

    const state = {
      active: CACHE,
      previous,
      lastGood:
        oldState.lastGood &&
        await cacheIsComplete(oldState.lastGood)
          ? oldState.lastGood
          : previous,
      candidate: CACHE,
      rollbackAvailable: Boolean(previous)
    };

    await writeState(state);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};

  if (
    data.type !== 'TIRECALC_BOOT_OK' &&
    data.type !== 'TIRECALC_BOOT_FAIL'
  ) {
    return;
  }

  event.waitUntil((async () => {
    const state = await readState();

    if (state.active !== CACHE || state.candidate !== CACHE) {
      return;
    }

    if (data.type === 'TIRECALC_BOOT_OK') {
      state.lastGood = CACHE;
      state.candidate = null;
      state.rollbackAvailable = Boolean(state.previous);
      await writeState(state);
      return;
    }

    let fallback = null;

    if (
      state.previous &&
      await cacheIsComplete(state.previous)
    ) {
      fallback = state.previous;
    } else if (
      state.lastGood &&
      state.lastGood !== CACHE &&
      await cacheIsComplete(state.lastGood)
    ) {
      fallback = state.lastGood;
    }

    if (!fallback) {
      state.candidate = null;
      state.rollbackAvailable = false;
      await writeState(state);
      return;
    }

    state.active = fallback;
    state.candidate = null;
    state.rollbackAvailable = false;

    await writeState(state);

    const clients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });

    for (const client of clients) {
      client.postMessage({ type: 'TIRECALC_ROLLBACK' });
    }
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const state = await readState();
    const selectedCache = state.active || CACHE;
    const cache = await caches.open(selectedCache);

    const cached = await cache.match(event.request, {
      ignoreSearch: true
    });

    if (cached) return cached;

    try {
      return await fetch(event.request);
    } catch (_) {
      if (event.request.mode === 'navigate') {
        const fallback = await cache.match('./index.html');
        if (fallback) return fallback;
      }

      return new Response('Нет подключения к интернету.', {
        status: 503,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8'
        }
      });
    }
  })());
});