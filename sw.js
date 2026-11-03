// オフラインでの動作と、共有で届いたファイルの受け取り。ファイルは端末の外へ送らない
import { addToInbox } from './js/storage.js';

const VERSION = '96816a0b3c'; // build.mjs が置き換える
const CACHE = `ruby-reader-${VERSION}`;
const ASSETS = [
  './',
  './app.css',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './js/app.js',
  './js/decode.js',
  './js/dropbox.js',
  './js/library.js',
  './js/position.js',
  './js/reader.js',
  './js/render.js',
  './js/ruby.js',
  './js/settings.js',
  './js/storage.js',
  './manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // HTTP キャッシュ（GitHub Pages は10分）を通すと、公開の直後は新しい版の名前で古いファイルを保存してしまう
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('ruby-reader-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function receiveShare(request) {
  const form = await request.formData();
  const entries = form
    .getAll('files')
    .filter((f) => f instanceof File && f.size > 0)
    .map((file) => ({ kind: 'file', name: file.name, blob: file }));
  if (!entries.length) {
    entries.push({ kind: 'text', title: form.get('title') ?? '', text: form.get('text') ?? '', url: form.get('url') ?? '' });
  }
  await addToInbox(entries);
  return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== 'GET') return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (request.mode === 'navigate') return (await cache.match('./')) ?? fetch(request);
      return (await cache.match(url.pathname.endsWith('/') ? './' : request)) ?? fetch(request);
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'version') event.source?.postMessage({ version: VERSION });
});
