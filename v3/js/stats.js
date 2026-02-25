// WPPhoto v3 - Daily share statistics
WP.stats = {
  _getTodayKey() {
    const d = new Date();
    return 'stats-' + d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  },

  async load() {
    const key = this._getTodayKey();
    const result = await chrome.storage.local.get(key);
    const names = result[key] || [];
    document.getElementById('stats-count').textContent = names.length + ' kisi';

    // Clean old entries in background (non-blocking)
    this._cleanOldEntries();
  },

  // Remove stats entries older than 30 days to prevent storage bloat
  async _cleanOldEntries() {
    try {
      const allItems = await chrome.storage.local.get(null);
      const keysToRemove = [];
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - 30);

      for (const key of Object.keys(allItems)) {
        if (!key.startsWith('stats-')) continue;
        // Parse "stats-YYYY-M-D" format
        const parts = key.substring(6).split('-');
        if (parts.length !== 3) continue;
        const year = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10) - 1; // JS months are 0-indexed
        const day = parseInt(parts[2], 10);
        if (isNaN(year) || isNaN(month) || isNaN(day)) continue;
        const entryDate = new Date(year, month, day);
        if (entryDate < cutoffDate) {
          keysToRemove.push(key);
        }
      }

      if (keysToRemove.length > 0) {
        await chrome.storage.local.remove(keysToRemove);
        console.log('[WPPhoto] Cleaned ' + keysToRemove.length + ' old stats entries');
      }
    } catch (e) {
      console.warn('[WPPhoto] Stats cleanup failed:', e);
    }
  },

  async track() {
    let chatName = null;
    try {
      const tab = await WP.tab.getWhatsAppTab();
      chatName = await new Promise(resolve => {
        chrome.tabs.sendMessage(tab.id, { action: 'GET_CHAT_NAME' }, response => {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(response?.chatName || null);
        });
      });
    } catch (e) {}

    if (!chatName) return;

    const key = this._getTodayKey();
    const result = await chrome.storage.local.get(key);
    const names = result[key] || [];
    if (!names.includes(chatName)) {
      names.push(chatName);
      await chrome.storage.local.set({ [key]: names });
    }
    document.getElementById('stats-count').textContent = names.length + ' kisi';
  },
};
