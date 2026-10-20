/* Test-only automatic rollback worker — v11 */

const CACHE = 'tirecalc-shared-v11';
const CACHE_PREFIX = 'tirecalc-shared-v';
const CONTROL_CACHE = 'tirecalc-control-v2';

const STATE_URL = new URL(
  './__tirecalc_state__.json',
  self.location.href
).href;

const FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

function fileUrl(path) {
  return new URL(path, self.location.href).href;
}

async function readState() {
  try {
    const cache = await caches.open(CONTROL_CACHE);
    const response = await cache.match(STATE_URL);
    return response ? await response.json() : null;
  } catch (_) {
    return null;
  }
}

async function writeState(state) {
  const cache = await caches.open(CONTROL_CACHE);

  await cache.put(
    STATE_URL,
    new Response(JSON.stringify(state), {
      headers: {
        'Content-Type': 'application/json'
      }
    })
  );
}

async function cacheIsComplete(name) {
  if (!name) return false;

  try {
    const cache = await caches.open(name);

    for (const file of FILES) {
      if (!await cache.match(fileUrl(file))) {
        return false;
      }
    }

    return true;
  } catch (_) {
    return false;
  }
}

function versionNumber(name) {
  const match = name.match(/tirecalc-shared-v(\d+)$/);
  return match ? Number(match[1]) : -1;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);

    // Install only if every required file can be cached.
    await cache.addAll(FILES);

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const state = await readState();
    const keys = await caches.keys();

    let previous = null;

    // Prefer the last version that reported a successful startup.
    const preferred = [
      state && state.lastGood,
      state && state.active
    ];

    for (const name of preferred) {
      if (
        name &&
        name !== CACHE &&
        keys.includes(name) &&
        await cacheIsComplete(name)
      ) {
        previous = name;
        break;
      }
    }

    // Otherwise, use the newest complete older cache.
    if (!previous) {
      const candidates = keys
        .filter(name =>
          name.startsWith(CACHE_PREFIX) &&
          name !== CACHE
        )
        .sort((a, b) =>
          versionNumber(b) - versionNumber(a)
        );

      for (const name of candidates) {
        if (await cacheIsComplete(name)) {
          previous = name;
          break;
        }
      }
    }

    const lastGood =
      state &&
      state.lastGood &&
      await cacheIsComplete(state.lastGood)
        ? state.lastGood
        : previous;

    await writeState({
      active: CACHE,
      previous,
      lastGood,
      rollbackAvailable: Boolean(previous),
      version: CACHE
    });

    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  const type = event.data && event.data.type;

  if (
    type !== 'TIRECALC_BOOT_OK' &&
    type !== 'TIRECALC_BOOT_FAIL'
  ) {
    return;
  }

  event.waitUntil((async () => {
    const state = await readState();

    if (!state) return;

    // The new version is considered good only after the app reports success.
    if (type === 'TIRECALC_BOOT_OK') {
      if (state.active === CACHE) {
        state.lastGood = CACHE;

        state.rollbackAvailable = Boolean(
          state.previous &&
          await cacheIsComplete(state.previous)
        );

        await writeState(state);
      }

      return;
    }

    // Roll back only when a complete previous cache exists.
    if (
      state.active !== CACHE ||
      !state.previous ||
      !state.rollbackAvailable ||
      !await cacheIsComplete(state.previous)
    ) {
      return;
    }

    // Change the selected cache before asking pages to reload.
    state.active = state.previous;
    state.rollbackAvailable = false;

    await writeState(state);

    const clients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });

    for (const client of clients) {
      client.postMessage({
        type: 'TIRECALC_ROLLBACK',
        from: CACHE,
        to: state.active
      });
    }
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const state = await readState();

    const activeName =
      state && state.active
        ? state.active
        : CACHE;

    const cache = await caches.open(activeName);

    const cached = await cache.match(
      request,
      request.mode === 'navigate'
        ? { ignoreSearch: true }
        : {}
    );

    if (cached) return cached;

    // Do not mix network responses into a versioned cache.
    try {
      return await fetch(request);
    } catch (_) {
      if (request.mode === 'navigate') {
        const fallback = await cache.match(
          fileUrl('./index.html')
        );

        if (fallback) return fallback;
      }

      return Response.error();
    }
  })());
});
