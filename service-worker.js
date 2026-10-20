const CACHE = 'tirecalc-shared-v5';
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
  const control = await caches.open(CONTROL_CACHE);
  const response = await control.match(STATE_URL);

  if (!response) return null;

  try {
    return await response.json();
  } catch (_) {
    return null;
  }
}

async function writeState(state) {
  const control = await caches.open(CONTROL_CACHE);

  await control.put(
    STATE_URL,
    new Response(JSON.stringify(state), {
      headers: {
        'Content-Type': 'application/json'
      }
    })
  );
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const oldState = await readState();
    const keys = await caches.keys();

    const previousCaches = keys
      .filter(key =>
        key.startsWith(CACHE_PREFIX) &&
        key !== CACHE
      )
      .sort()
      .reverse();

        const lastGood =
      oldState &&
      oldState.lastGood &&
      oldState.lastGood !== CACHE &&
      keys.includes(oldState.lastGood)
        ? oldState.lastGood
        : null;

    const oldActive =
      oldState &&
      oldState.active &&
      oldState.active !== CACHE &&
      keys.includes(oldState.active)
        ? oldState.active
        : null;

    const previous =
      lastGood ||
      oldActive ||
      previousCaches[0] ||
      null;

    await writeState({
      active: CACHE,
      previous: previous,
      lastGood: oldState ? oldState.lastGood || null : null,
      rollbackAvailable: Boolean(previous)
    });

    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (!event.data) return;

  const type = event.data.type;

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
      !state.rollbackAvailable
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
