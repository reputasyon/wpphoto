// idb-keyval - Minimal IndexedDB key-value store
// Based on Jake Archibald's idb-keyval (https://github.com/jakearchibald/idb-keyval)
// Vendored for Chrome Extension use (no external dependencies)

const DB_NAME = 'wpphoto-store';
const STORE_NAME = 'keyval';

function getDB() {
  if (!getDB._promise) {
    getDB._promise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return getDB._promise;
}

function getStore(mode) {
  return getDB().then(db => {
    const tx = db.transaction(STORE_NAME, mode);
    return tx.objectStore(STORE_NAME);
  });
}

function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet(key) {
  const store = await getStore('readonly');
  return promisifyRequest(store.get(key));
}

async function idbSet(key, value) {
  const store = await getStore('readwrite');
  store.put(value, key);
  return promisifyRequest(store.transaction);
}

async function idbDel(key) {
  const store = await getStore('readwrite');
  store.delete(key);
  return promisifyRequest(store.transaction);
}
