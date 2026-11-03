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

// 書き込みは必ずここを通し、応答を待たずに確定を指示する。
// 応答を待っているあいだにページが凍結されると、ロックを持ったまま止まり、ほかのページの読み書きまで止めてしまう。
// ページを閉じる途中の書き込み（pagehide）が消えないようにするためにも要る
async function write(names, fill) {
  const db = await openDb();
  const tx = db.transaction(names, 'readwrite');
  fill(tx);
  tx.commit?.();
  await done(tx);
}

export const addToInbox = (entries) =>
  write('inbox', (tx) => {
    for (const e of entries) tx.objectStore('inbox').add(e);
  });

// 起動のたびに呼ばれる。ほとんどの場合は空なので、読むだけで済ませて書き込みのロックを取らない
export async function takeInbox() {
  const db = await openDb();
  const store = db.transaction('inbox').objectStore('inbox');
  const [keys, entries] = await Promise.all([result(store.getAllKeys()), result(store.getAll())]);
  if (keys.length) {
    await write('inbox', (tx) => {
      for (const key of keys) tx.objectStore('inbox').delete(key);
    });
  }
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

export const putDoc = (doc) => write('docs', (tx) => tx.objectStore('docs').put(doc));
export const putBook = (book) => write('books', (tx) => tx.objectStore('books').put(book));

// 文書と束をまとめて1回で書く
export const saveAll = (docs, books) =>
  write(['docs', 'books'], (tx) => {
    for (const d of docs) tx.objectStore('docs').put(d);
    for (const b of books) tx.objectStore('books').put(b);
  });

export const removeDocs = (ids, bookId) =>
  write(['docs', 'books'], (tx) => {
    for (const id of ids) tx.objectStore('docs').delete(id);
    if (bookId) tx.objectStore('books').delete(bookId);
  });
