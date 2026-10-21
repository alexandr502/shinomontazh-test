/* TireCalc test service worker — v14
   Test repository only.
   Do not copy to production until verified.
*/

const VERSION = 14;
const BOOT_TIMEOUT_MS = 20000;
const CACHE = `tirecalc-shared-v${VERSION}`;
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
  candidateStartedAt: null,
  rollbackAvailable: false
};

function scopedUrl(path) {
  return new URL(path, self.registration.scope).href;
}

async function readState() {
  try {
    const cache = await caches.open(CONTROL_CACHE);
    const response = await cache.match(scopedUrl(CONTROL_KEY));

    if (response) {
      return {
        ...DEFAULT_STATE,
        ...(await response.json())
      };
    }
  } catch (error) {
    console.error('[TireCalc] Failed to read state:', error);
  }

  return { ...DEFAULT_STATE };
}

async function writeState(state) {
  const cache = await caches.open(CONTROL_CACHE);

  await cache.put(
    scopedUrl(CONTROL_KEY),
    new Response(JSON.stringify(state), {
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

async function cacheIsComplete(cacheName) {
  try {
    const cache = await caches.open(cacheName);

    const results = await Promise.all(
      FILES.map((file) => cache.match(scopedUrl(file)))
    );

    return results.every(Boolean);
  } catch (error) {
    console.error(
      `[TireCalc] Cache check failed for ${cacheName}:`,
      error
    );
    return false;
  }
}

function versionNumber(cacheName) {
  const match = cacheName.match(/^tirecalc-shared-v(\d+)$/);
  return match ? Number(match[1]) : -1;
}

async function findPreviousCache() {
  const names = await caches.keys();

  const candidates = names
    .filter(
      (name) =>
        name.startsWith(CACHE_PREFIX) &&
        name !== CACHE &&
        versionNumber(name) >= 0
    )
    .sort((a, b) => versionNumber(b) - versionNumber(a));

  for (const name of candidates) {
    if (await cacheIsComplete(name)) {
      return name;
    }
  }

  return null;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);

    // Installation fails if any required file cannot be cached.
    await cache.addAll(FILES);

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const oldState = await readState();
    const previous = await findPreviousCache();

    const lastGood =
      oldState.lastGood &&
      oldState.lastGood !== CACHE &&
      await cacheIsComplete(oldState.lastGood)
        ? oldState.lastGood
        : previous;

        const state = {
      active: CACHE,
      previous,
      lastGood,
      candidate: CACHE,
      candidateStartedAt: Date.now(),
      rollbackAvailable: Boolean(previous)
    };

    await writeState(state);
    await self.clients.claim();

    console.log('[TireCalc] Activated:', CACHE);
    console.log('[TireCalc] Previous:', previous);
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

    // Ignore reports from a version that is no longer the candidate.
    if (
      state.active !== CACHE ||
      state.candidate !== CACHE
    ) {
      return;
    }

    if (data.type === 'TIRECALC_BOOT_OK') {
      state.lastGood = CACHE;
      state.candidate = null;
      state.candidateStartedAt = null;
      state.rollbackAvailable = Boolean(
        state.previous &&
        await cacheIsComplete(state.previous)
      );

      await writeState(state);

      console.log('[TireCalc] Successful startup:', CACHE);
      return;
    }

    let fallback = null;

    if (
      state.previous &&
      state.previous !== CACHE &&
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
      state.candidateStartedAt = null;
      state.rollbackAvailable = false;

      await writeState(state);

      console.error(
        '[TireCalc] Startup failed; no complete fallback cache.'
      );
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
      client.postMessage({
        type: 'TIRECALC_ROLLBACK',
        version: fallback
      });
    }

    console.warn('[TireCalc] Rollback selected:', fallback);
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  const url = new URL(event.request.url);
  const scopeUrl = new URL(self.registration.scope);

  // Do not handle requests outside this application's scope.
  if (
    url.origin !== scopeUrl.origin ||
    !url.href.startsWith(scopeUrl.href)
  ) {
    return;
  }

  event.respondWith((async () => {
    const state = await readState();
    const selectedCache = state.active || CACHE;
    const cache = await caches.open(selectedCache);

    const cached = await cache.match(event.request, {
      ignoreSearch: true
    });

    if (cached) {
      return cached;
    }

    try {
      return await fetch(event.request);
    } catch (error) {
      if (event.request.mode === 'navigate') {
        const fallback = await cache.match(
          scopedUrl('./index.html')
        );

        if (fallback) {
          return fallback;
        }
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
