// WPPhoto v2 - Daily share statistics
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
