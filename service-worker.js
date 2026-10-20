/* Test-only rollback worker */
const CACHE = 'tirecalc-shared-v7';
const CACHE_PREFIX = 'tirecalc-shared-';
const CONTROL_CACHE = 'tirecalc-control-v1';

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

async function readState() {
  const cache = await caches.open(CONTROL_CACHE);
  const response = await cache.match(STATE_URL);

  if (!response) return null;

  try {
    return await response.json();
  } catch (_) {
    return null;
  }
}

async function writeState(state) {
  const cache = await caches.open(CONTROL_CACHE);

  await cache.put(
    STATE_URL,
    new Response(JSON.stringify(state), {
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

async function cacheHasFiles(name) {
  if (!name) return false;

  try {
    const cache = await caches.open(name);

    const root = await cache.match(
      new URL('./', self.location.href).href
    );

    const index = await cache.match(
      new URL('./index.html', self.location.href).href
    );

    return Boolean(root || index);
  } catch (_) {
    return false;
  }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(FILES);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const state = await readState();
    const keys = await caches.keys();

    let previous = null;

    if (
      state &&
      state.lastGood &&
      state.lastGood !== CACHE &&
      keys.includes(state.lastGood) &&
      await cacheHasFiles(state.lastGood)
    ) {
      previous = state.lastGood;
    }

    if (
      !previous &&
      state &&
      state.active &&
      state.active !== CACHE &&
      keys.includes(state.active) &&
      await cacheHasFiles(state.active)
    ) {
      previous = state.active;
    }

    if (!previous) {
      const candidates = keys
        .filter(name =>
          name.startsWith(CACHE_PREFIX) &&
          name !== CACHE
        )
        .sort()
        .reverse();

      for (const name of candidates) {
        if (await cacheHasFiles(name)) {
          previous = name;
          break;
        }
      }
    }

    await writeState({
      active: CACHE,
      previous,
      lastGood: state && state.lastGood
        ? state.lastGood
        : null,
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

    if (type === 'TIRECALC_BOOT_OK') {
      if (state.active === CACHE) {
        state.lastGood = CACHE;
        await writeState(state);
      }

      return;
    }

    if (
      state.active !== CACHE ||
      !state.previous ||
      !state.rollbackAvailable ||
      !(await cacheHasFiles(state.previous))
    ) {
      return;
    }

    state.active = state.previous;
    state.rollbackAvailable = false;

    await writeState(state);

    const clients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });

    for (const client of clients) {
      client.postMessage({
        type: 'TIRECALC_ROLLBACK'
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
    const cached = await cache.match(request);

    if (cached) return cached;

    try {
      const response = await fetch(request);

      if (response && response.ok) {
        cache.put(request, response.clone()).catch(() => {});
      }

      return response;
    } catch (_) {
      if (request.mode === 'navigate') {
        const page = await cache.match(
          new URL('./index.html', self.location.href).href
        );

        if (page) return page;
      }

      return Response.error();
    }
  })());
});
