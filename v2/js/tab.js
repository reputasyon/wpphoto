// WPPhoto v2 - WhatsApp tab management
WP.tab = {
  async getWhatsAppTab() {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab && activeTab.url && activeTab.url.includes('web.whatsapp.com')) {
      return activeTab;
    }

    const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
    if (tabs.length) return tabs[0];

    throw new Error('WhatsApp Web acik degil!');
  },

  async ensureContentScript(tab) {
    // Phase 1: Check if content script is already running
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'PING' });
      if (response && response.ready) return;
    } catch (e) {
      // Content script not loaded
    }

    // Phase 2: Inject content script
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
    await WP.utils.sleep(WP.config.WAIT.CONTENT_INJECT);

    // Phase 3: Verify injection
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'PING' });
      if (response && response.ready) return;
    } catch (e) {
      throw new Error('Content script yuklenemedi');
    }
  },
};
