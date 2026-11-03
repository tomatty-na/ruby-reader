// 端末内の保存（IndexedDB）。service worker からも使う

const DB_NAME = 'ruby-reader';
const DB_VERSION = 1;

let dbPromise;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('inbox', { autoIncrement: true }); // 共有で届いて、まだ取り込んでいないもの
      db.createObjectStore('docs', { keyPath: 'id' });
      db.createObjectStore('books', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const done = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

const result = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export async function addToInbox(entries) {
  const db = await openDb();
  const tx = db.transaction('inbox', 'readwrite');
  for (const e of entries) tx.objectStore('inbox').add(e);
  await done(tx);
}

export async function takeInbox() {
  const db = await openDb();
  const tx = db.transaction('inbox', 'readwrite');
  const store = tx.objectStore('inbox');
  const entries = await result(store.getAll());
  store.clear();
  await done(tx);
  return entries;
}

async function getAll(name) {
  const db = await openDb();
  return result(db.transaction(name).objectStore(name).getAll());
}

export const getDocs = () => getAll('docs');
export const getBooks = () => getAll('books');

export async function getDoc(id) {
  const db = await openDb();
  return result(db.transaction('docs').objectStore('docs').get(id));
}

export async function putDoc(doc) {
  const db = await openDb();
  const tx = db.transaction('docs', 'readwrite');
  tx.objectStore('docs').put(doc);
  // ページを閉じる途中でも書けるように、応答を待たずに確定を指示する（pagehide からの保存が消えないように）
  tx.commit?.();
  await done(tx);
}

export async function putBook(book) {
  const db = await openDb();
  const tx = db.transaction('books', 'readwrite');
  tx.objectStore('books').put(book);
  await done(tx);
}

// 文書と束をまとめて1回で書く
export async function saveAll(docs, books) {
  const db = await openDb();
  const tx = db.transaction(['docs', 'books'], 'readwrite');
  for (const d of docs) tx.objectStore('docs').put(d);
  for (const b of books) tx.objectStore('books').put(b);
  await done(tx);
}

export async function removeDocs(ids, bookId) {
  const db = await openDb();
  const tx = db.transaction(['docs', 'books'], 'readwrite');
  for (const id of ids) tx.objectStore('docs').delete(id);
  if (bookId) tx.objectStore('books').delete(bookId);
  await done(tx);
}
