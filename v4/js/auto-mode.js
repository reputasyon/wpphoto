// WPPhoto v3 - Auto-mode toggle and trigger listener
WP.autoMode = {

  async toggle() {
    WP.state.autoModeEnabled = !WP.state.autoModeEnabled;
    document.getElementById('auto-mode-bar').classList.toggle('active', WP.state.autoModeEnabled);
    await chrome.storage.local.set({ autoMode: WP.state.autoModeEnabled });

    // Notify content script
    try {
      const tab = await WP.tab.getWhatsAppTab();
      await WP.tab.ensureContentScript(tab);
      chrome.tabs.sendMessage(tab.id, { action: 'SET_AUTO_MODE', enabled: WP.state.autoModeEnabled });
    } catch (e) {
      // WhatsApp not open, that's fine
    }

    WP.utils.showToast(
      WP.state.autoModeEnabled ? 'Otomatik yanit ACIK' : 'Otomatik yanit KAPALI',
      WP.state.autoModeEnabled ? 'success' : 'info'
    );
  },

  async load() {
    const result = await chrome.storage.local.get('autoMode');
    WP.state.autoModeEnabled = result.autoMode || false;
    document.getElementById('auto-mode-bar').classList.toggle('active', WP.state.autoModeEnabled);

    // Notify content script
    try {
      const tab = await WP.tab.getWhatsAppTab();
      chrome.tabs.sendMessage(tab.id, { action: 'SET_AUTO_MODE', enabled: WP.state.autoModeEnabled });
    } catch (e) {}
  },

  async _handleAutoSend(category) {
    // Wait if another send is in progress
    let retries = 0;
    while (WP.state.isSending && retries < 10) {
      await WP.utils.sleep(2000);
      retries++;
    }
    if (WP.state.isSending) return;
    if (WP.state.categories.size === 0) return;

    // Find category (case-insensitive)
    let matchedName = null;
    for (const name of WP.state.categories.keys()) {
      if (name.toLowerCase() === category.toLowerCase()) {
        matchedName = name;
        break;
      }
    }

    if (!matchedName) {
      console.log('[WPPhoto] Kategori bulunamadi: ' + category);
      return;
    }

    // Find button element for visual feedback
    const btns = document.getElementById('category-list').querySelectorAll('.category-btn');
    let btnElement = null;
    for (const btn of btns) {
      const nameEl = btn.querySelector('.cat-name');
      if (nameEl && nameEl.textContent === matchedName) {
        btnElement = btn;
        break;
      }
    }

    if (btnElement) {
      WP.utils.showToast('#' + category + ' algilandi, gonderiliyor...', 'info');
      await WP.sender.sendCategory(matchedName, btnElement);
    }
  },

  async _handleAutoSendAll() {
    // Wait if another send is in progress
    let retries = 0;
    while (WP.state.isSending && retries < 10) {
      await WP.utils.sleep(2000);
      retries++;
    }
    if (WP.state.isSending) return;
    if (WP.state.categories.size === 0) return;

    WP.utils.showToast('#hepsi algilandi, tum kategoriler gonderiliyor...', 'info');
    await WP.sender.sendAllCategories();
  },
};

// Message listener for auto-send triggers
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!WP.state.autoModeEnabled) return;

  if (message.action === 'AUTO_SEND_TRIGGER') {
    if (message.category.toLowerCase() === 'hepsi') {
      WP.autoMode._handleAutoSendAll();
    } else {
      WP.autoMode._handleAutoSend(message.category);
    }
  }
});
