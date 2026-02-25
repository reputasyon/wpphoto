// WPPhoto v3 - IndexedDB helpers
WP.idb = (() => {
  let dbPromise = null;

  function getDB() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(WP.config.DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(WP.config.STORE_NAME);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      // Clear cache on failure so next call retries instead of returning stale rejection
      dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
  }

  return {
    async get(key) {
      const db = await getDB();
      const tx = db.transaction(WP.config.STORE_NAME, 'readonly');
      const store = tx.objectStore(WP.config.STORE_NAME);
      return new Promise((resolve, reject) => {
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },

    async set(key, value) {
      const db = await getDB();
      const tx = db.transaction(WP.config.STORE_NAME, 'readwrite');
      const store = tx.objectStore(WP.config.STORE_NAME);
      store.put(value, key);
      return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
  };
})();
