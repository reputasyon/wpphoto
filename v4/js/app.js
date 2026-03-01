// WPPhoto v4 - Entry point, wires everything together
WP.app = {

  async init() {
    try {
      const savedHandle = await WP.idb.get(WP.config.DIR_HANDLE_KEY);
      if (savedHandle) {
        const permission = await savedHandle.queryPermission({ mode: 'read' });
        if (permission === 'granted') {
          WP.state.dirHandle = savedHandle;
          await WP.app.loadCategories();
          return;
        }
        // Request permission (requires user gesture)
        try {
          const requested = await savedHandle.requestPermission({ mode: 'read' });
          if (requested === 'granted') {
            WP.state.dirHandle = savedHandle;
            await WP.app.loadCategories();
            return;
          }
        } catch (e) {
          // Permission could not be requested, user must re-select
        }
      }
    } catch (e) {
      console.warn('[WPPhoto] Kayitli klasor yuklenemedi:', e);
    }
    WP.app._showEmptyState();
  },

  async selectFolder() {
    try {
      if (window.showDirectoryPicker) {
        WP.state.dirHandle = await window.showDirectoryPicker({ mode: 'read' });
        await WP.idb.set(WP.config.DIR_HANDLE_KEY, WP.state.dirHandle);
        await WP.app.loadCategories();
      } else {
        WP.utils.showToast('Bu tarayici klasor secmeyi desteklemiyor', 'error');
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        WP.utils.showToast('Klasor secilemedi: ' + err.message, 'error');
      }
    }
  },

  async refreshFolder() {
    if (!WP.state.dirHandle) return;
    await WP.app.loadCategories();
    WP.utils.showToast('Yenilendi', 'success');
  },

  async loadCategories() {
    if (!WP.state.dirHandle) return;

    WP.app._showLoading();
    WP.state.categories = new Map();
    await WP.ui._loadCategoryOrder();

    try {
      for await (const entry of WP.state.dirHandle.values()) {
        if (entry.kind === 'directory') {
          const files = [];
          try {
            for await (const fileEntry of entry.values()) {
              if (fileEntry.kind === 'file' && WP.utils.isImage(fileEntry.name)) {
                files.push({
                  name: fileEntry.name,
                  handle: fileEntry,
                  categoryName: entry.name,
                });
              }
            }
          } catch (e) {
            console.warn('[WPPhoto] Klasor okunamadi:', entry.name, e);
          }
          if (files.length > 0) {
            files.sort((a, b) => a.name.localeCompare(b.name));
            WP.state.categories.set(entry.name, files);
          }
        } else if (entry.kind === 'file' && WP.utils.isImage(entry.name)) {
          if (!WP.state.categories.has('Genel')) WP.state.categories.set('Genel', []);
          WP.state.categories.get('Genel').push({
            name: entry.name,
            handle: entry,
            categoryName: 'Genel',
          });
        }
      }

      if (WP.state.categories.has('Genel')) {
        WP.state.categories.get('Genel').sort((a, b) => a.name.localeCompare(b.name));
      }

      // Update folder name display
      const folderNameEl = document.getElementById('folder-name');
      folderNameEl.textContent = WP.state.dirHandle.name;
      folderNameEl.classList.remove('hidden');
      document.getElementById('btn-refresh').classList.remove('hidden');
      document.getElementById('btn-change-folder').classList.remove('hidden');

      if (WP.state.categories.size === 0) {
        WP.app._showEmptyState();
        WP.utils.showToast('Klasorde fotograf bulunamadi', 'info');
        return;
      }

      WP.app._hideLoading();
      document.getElementById('empty-state').classList.add('hidden');
      document.getElementById('auto-mode-bar').classList.remove('hidden');
      document.getElementById('catalog-bar').classList.remove('hidden');
      document.getElementById('send-all-bar').classList.remove('hidden');
      document.getElementById('story-scanner-bar').classList.remove('hidden');
      document.getElementById('daily-stats').classList.remove('hidden');
      WP.ui.renderCategoryButtons();
      WP.autoMode.load();
      WP.stats.load();
      WP.storyScanner.populateCategorySelect();
      WP.app.loadPhoneNumber();
    } catch (err) {
      WP.app._hideLoading();
      WP.utils.showToast('Yuklenemedi: ' + err.message, 'error');
      WP.app._showEmptyState();
    }
  },

  async savePhoneNumber() {
    const phoneInput = document.getElementById('phone-input');
    const phone = phoneInput.value.replace(/\D/g, '');
    if (!phone || phone.length < 10 || phone.length > 15) {
      WP.utils.showToast('Gecerli bir telefon numarasi girin (10-15 hane)', 'error');
      return;
    }
    phoneInput.value = phone;
    await chrome.storage.local.set({ whatsappPhone: phone });
    const saveBtn = document.getElementById('btn-save-phone');
    saveBtn.classList.add('saved');
    WP.utils.showToast('Numara kaydedildi', 'success');
    setTimeout(() => saveBtn.classList.remove('saved'), 2000);
  },

  async loadPhoneNumber() {
    const result = await chrome.storage.local.get('whatsappPhone');
    if (result.whatsappPhone) {
      document.getElementById('phone-input').value = result.whatsappPhone;
    }
  },

  // --- Private UI helpers ---

  _showEmptyState() {
    document.getElementById('empty-state').classList.remove('hidden');
    document.getElementById('category-list').innerHTML = '';
    WP.app._hideLoading();
  },

  _showLoading() {
    document.getElementById('loading').classList.remove('hidden');
    document.getElementById('empty-state').classList.add('hidden');
    document.getElementById('category-list').innerHTML = '';
  },

  _hideLoading() {
    document.getElementById('loading').classList.add('hidden');
  },
};

// --- Event wiring ---
document.getElementById('btn-select-folder').addEventListener('click', () => WP.app.selectFolder());
document.getElementById('btn-refresh').addEventListener('click', () => WP.app.refreshFolder());
document.getElementById('btn-change-folder').addEventListener('click', () => WP.app.selectFolder());
document.getElementById('btn-auto-toggle').addEventListener('click', () => WP.autoMode.toggle());
document.getElementById('btn-send-all').addEventListener('click', () => WP.sender.handleSendAllClick());
document.getElementById('btn-save-phone').addEventListener('click', () => WP.app.savePhoneNumber());
document.getElementById('btn-generate-catalog').addEventListener('click', () => WP.catalog.generatePage());
document.getElementById('btn-story-scan').addEventListener('click', () => WP.storyScanner.startScan());
document.getElementById('btn-scanner-settings').addEventListener('click', () => WP.storyScanner.toggleSettings());

// --- Bootstrap ---
WP.app.init();
