// WPPhoto v5 - Contact Scanner: scan contacts, filter by labels, send catalogs
WP.contactScanner = {

  _pendingTargets: null,
  _allScannedContacts: null,
  _CACHE_KEY: 'contactListCache',
  _CACHE_MAX_AGE: 24 * 60 * 60 * 1000, // 24 saat

  async startScan() {
    if (WP.contactScanner._pendingTargets) {
      WP.contactScanner._startSending();
      return;
    }

    if (WP.state.isSending) {
      WP.utils.showToast('Gonderim devam ediyor, bekleyin', 'info');
      return;
    }
    if (WP.state.contactScannerRunning) {
      WP.state.contactScannerCancelled = true;
      return;
    }

    // Cache kontrol
    const cached = await WP.contactScanner._loadFromCache();
    if (cached) {
      WP.contactScanner._applyFilterAndPreview(cached, true);
      return;
    }

    // Cache yok veya eski — WhatsApp'tan tara
    await WP.contactScanner._scanFromWhatsApp();
  },

  async forceScan() {
    if (WP.state.isSending || WP.state.contactScannerRunning) {
      WP.utils.showToast('Islem devam ediyor, bekleyin', 'info');
      return;
    }
    // Preview aciksa kapat
    WP.contactScanner._pendingTargets = null;
    WP.contactScanner._allScannedContacts = null;
    document.getElementById('contact-scanner-preview').classList.add('hidden');

    await chrome.storage.local.remove(WP.contactScanner._CACHE_KEY);
    await WP.contactScanner._scanFromWhatsApp();
  },

  async _loadFromCache() {
    const result = await chrome.storage.local.get(WP.contactScanner._CACHE_KEY);
    const cache = result[WP.contactScanner._CACHE_KEY];
    if (!cache || !cache.contacts || !cache.timestamp) return null;

    const age = Date.now() - cache.timestamp;
    if (age > WP.contactScanner._CACHE_MAX_AGE) {
      console.log('[WPPhoto] Cache eski (' + Math.round(age / 3600000) + ' saat), yeniden taranacak');
      return null;
    }

    console.log('[WPPhoto] Cache\'den yuklendi: ' + cache.contacts.length + ' kisi (' + Math.round(age / 60000) + ' dk once)');
    return cache.contacts;
  },

  async _saveToCache(contacts) {
    await chrome.storage.local.set({
      [WP.contactScanner._CACHE_KEY]: {
        contacts: contacts,
        timestamp: Date.now(),
        count: contacts.length,
      },
    });
    console.log('[WPPhoto] Cache kaydedildi: ' + contacts.length + ' kisi');
  },

  async _scanFromWhatsApp() {
    WP.state.contactScannerRunning = true;
    WP.state.contactScannerCancelled = false;
    WP.contactScanner._updateUI('scanning');

    try {
      const tab = await WP.tab.getWhatsAppTab();
      await WP.tab.ensureContentScript(tab);

      WP.contactScanner._updateProgress(0, 0, 'Rehber taraniyor...');

      const scanResult = await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tab.id, { action: 'SCAN_CONTACT_LIST' }, response => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (response && response.success) {
            resolve(response.contacts);
          } else {
            reject(new Error(response?.error || 'Tarama basarisiz'));
          }
        });
      });

      if (scanResult.length === 0) {
        WP.utils.showToast('Rehberde kisi bulunamadi', 'info');
        return;
      }

      console.log('[WPPhoto] Rehber kisileri: ' + scanResult.length + ' kisi');

      // Cache'e kaydet
      await WP.contactScanner._saveToCache(scanResult);

      WP.contactScanner._applyFilterAndPreview(scanResult, false);

    } catch (err) {
      WP.utils.showToast('Tarama hatasi: ' + err.message, 'error');
    } finally {
      WP.state.contactScannerRunning = false;
      if (!WP.contactScanner._pendingTargets) {
        WP.contactScanner._updateUI('idle');
      }
    }
  },

  async _applyFilterAndPreview(allContacts, fromCache) {
    // Pre-filter: remove contacts messaged in last 30 days (from stats)
    const contacted = await WP.stats.getContactedInLast30Days();
    const filtered = allContacts.filter(name => !WP.stats.isContactedRecently(name, contacted));

    const source = fromCache ? 'cache' : 'tarama';
    console.log('[WPPhoto] Pre-filter (' + source + '): ' + allContacts.length + ' → ' + filtered.length + ' (' + (allContacts.length - filtered.length) + ' cikarildi)');

    if (filtered.length === 0) {
      WP.utils.showToast('Tum kisiler son 30 gunde zaten mesajlasilmis', 'info');
      WP.contactScanner._updateUI('idle');
      return;
    }

    const dailyLimit = WP.contactScanner._getDailyLimit();
    const targets = filtered.slice(0, dailyLimit);

    WP.contactScanner._allScannedContacts = filtered;
    WP.contactScanner._pendingTargets = targets;
    WP.contactScanner._showPreview(targets, allContacts.length, filtered.length, fromCache);
  },

  _showPreview(targets, totalScanned, totalAfterFilter, fromCache) {
    const previewEl = document.getElementById('contact-scanner-preview');
    const listEl = document.getElementById('contact-scanner-preview-list');
    const infoEl = document.getElementById('contact-scanner-preview-info');

    listEl.textContent = '';
    for (const name of targets) {
      const item = document.createElement('label');
      item.className = 'scanner-preview-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.value = name;
      const span = document.createElement('span');
      span.textContent = name;
      item.appendChild(cb);
      item.appendChild(document.createTextNode(' '));
      item.appendChild(span);
      listEl.appendChild(item);
    }

    const source = fromCache ? ' (cache)' : '';
    infoEl.textContent =
      totalScanned + ' kisi' + source + ', ' + (totalScanned - totalAfterFilter) + ' cikarildi (30 gun), ' + targets.length + ' listelendi';

    previewEl.classList.remove('hidden');

    const btn = document.getElementById('btn-contact-scan');
    const label = document.getElementById('contact-scanner-btn-label');
    btn.classList.add('ready');
    btn.classList.remove('scanning');
    label.textContent = 'Secilenleri Gonder';

    document.getElementById('contact-scanner-progress').classList.add('hidden');
  },

  _cancelPreview() {
    WP.contactScanner._pendingTargets = null;
    WP.contactScanner._allScannedContacts = null;
    document.getElementById('contact-scanner-preview').classList.add('hidden');
    WP.contactScanner._updateUI('idle');
    WP.utils.showToast('Iptal edildi', 'info');
  },

  async _startSending() {
    const checkboxes = document.querySelectorAll('#contact-scanner-preview-list input[type="checkbox"]');
    const selectedTargets = [];
    for (const cb of checkboxes) {
      if (cb.checked) selectedTargets.push(cb.value);
    }

    const selectedSet = new Set(selectedTargets);
    const reservePool = (WP.contactScanner._allScannedContacts || [])
      .filter(name => !selectedSet.has(name));

    WP.contactScanner._pendingTargets = null;
    WP.contactScanner._allScannedContacts = null;
    document.getElementById('contact-scanner-preview').classList.add('hidden');

    if (selectedTargets.length === 0) {
      WP.utils.showToast('Hic kisi secilmedi', 'info');
      WP.contactScanner._updateUI('idle');
      return;
    }

    if (WP.state.isSending) {
      WP.utils.showToast('Gonderim devam ediyor, bekleyin', 'info');
      WP.contactScanner._updateUI('idle');
      return;
    }

    WP.state.contactScannerRunning = true;
    WP.state.contactScannerCancelled = false;
    WP.contactScanner._updateUI('scanning');

    try {
      const tab = await WP.tab.getWhatsAppTab();
      await WP.tab.ensureContentScript(tab);

      const categoryToSend = WP.contactScanner._getSelectedCategory();
      const excludedLabels = WP.contactScanner._getExcludedLabels();
      const dailyLimit = WP.contactScanner._getDailyLimit();
      let sent = 0;
      let skipped = 0;
      let labelSkipped = 0;
      let failed = 0;
      const interContactDelay = WP.contactScanner._getInterContactDelay();

      const queue = [...selectedTargets];

      while (queue.length > 0 && sent < dailyLimit && !WP.state.contactScannerCancelled) {
        const contactName = queue.shift();

        WP.contactScanner._updateProgress(sent, dailyLimit,
          contactName + ' aciliyor... (' + sent + '/' + dailyLimit + ')');

        // 1. Switch to chat
        const switchResult = await new Promise((resolve) => {
          chrome.tabs.sendMessage(tab.id, {
            action: 'SWITCH_TO_CHAT',
            contactName: contactName,
          }, response => {
            if (chrome.runtime.lastError) { resolve(false); return; }
            resolve(response?.success || false);
          });
        });

        if (!switchResult) {
          failed++;
          WP.utils.showToast(contactName + ' acilamadi, atlaniyor', 'info');
          if (reservePool.length > 0) {
            const replacement = reservePool.shift();
            queue.push(replacement);
            console.log('[WPPhoto] Acilamadi, yedekten: ' + replacement);
          }
          await WP.utils.sleep(2000);
          continue;
        }

        await WP.utils.sleep(WP.config.STORY_SCANNER.CHAT_SETTLE);

        // 2. Check chat labels — skip if excluded label found
        if (excludedLabels.length > 0) {
          const labelResult = await new Promise((resolve) => {
            chrome.tabs.sendMessage(tab.id, { action: 'CHECK_CHAT_LABELS' }, response => {
              if (chrome.runtime.lastError) { resolve({ labels: [] }); return; }
              resolve(response || { labels: [] });
            });
          });

          const chatLabels = (labelResult.labels || []).map(l => l.toUpperCase());
          const hasExcluded = excludedLabels.some(el => chatLabels.includes(el));

          if (hasExcluded) {
            labelSkipped++;
            const matchedLabel = excludedLabels.find(el => chatLabels.includes(el));
            console.log('[WPPhoto] ETIKET ATLANDI: ' + contactName + ' (' + matchedLabel + ')');
            WP.contactScanner._updateProgress(sent, dailyLimit,
              contactName + ' atlandi (etiket: ' + matchedLabel + ')');
            WP.utils.showToast(contactName + ' atlandi - ' + matchedLabel, 'info');
            if (reservePool.length > 0) {
              queue.push(reservePool.shift());
            }
            await WP.utils.sleep(2000);
            continue;
          }
        }

        // 3. Check actual chat recency
        const recency = await new Promise((resolve) => {
          chrome.tabs.sendMessage(tab.id, {
            action: 'CHECK_CHAT_RECENCY',
            days: WP.config.STORY_SCANNER.COOLDOWN_DAYS,
          }, response => {
            if (chrome.runtime.lastError) { resolve({ hasRecent: false }); return; }
            resolve(response || { hasRecent: false });
          });
        });

        if (recency.hasRecent) {
          skipped++;
          console.log('[WPPhoto] ATLANDI (son 30 gun): ' + contactName + ' (' + recency.reason + ')');
          WP.contactScanner._updateProgress(sent, dailyLimit,
            contactName + ' atlandi (son 30 gun)');
          WP.utils.showToast(contactName + ' atlandi - son 30 gunde mesajlasilmis', 'info');
          if (reservePool.length > 0) {
            queue.push(reservePool.shift());
          }
          await WP.utils.sleep(2000);
          continue;
        }

        // 4. Send photos
        WP.contactScanner._updateProgress(sent, dailyLimit,
          contactName + ' gonderiliyor... (' + sent + '/' + dailyLimit + ')');

        try {
          if (categoryToSend === '__all__') {
            await WP.storyScanner._sendAllToCurrentChat(tab);
          } else {
            await WP.storyScanner._sendCategoryToCurrentChat(tab, categoryToSend);
          }
          sent++;
          await WP.stats.trackContact(contactName);
          WP.utils.showToast(sent + '/' + dailyLimit + ' - ' + contactName + ' gonderildi', 'success');
        } catch (err) {
          failed++;
          WP.utils.showToast(contactName + ' gonderilemedi: ' + err.message, 'error');
          if (reservePool.length > 0) {
            queue.push(reservePool.shift());
          }
        }

        if (queue.length > 0 && sent < dailyLimit && !WP.state.contactScannerCancelled) {
          WP.contactScanner._updateProgress(sent, dailyLimit,
            'Bekleniyor (' + (interContactDelay / 1000) + 's)...');
          await WP.utils.sleep(interContactDelay);
        }
      }

      if (WP.state.contactScannerCancelled) {
        WP.utils.showToast('Iptal edildi (' + sent + '/' + dailyLimit + ')', 'info');
      }

      const parts = [];
      if (sent > 0) parts.push(sent + ' gonderildi');
      if (skipped > 0) parts.push(skipped + ' atlandi (30 gun)');
      if (labelSkipped > 0) parts.push(labelSkipped + ' atlandi (etiket)');
      if (failed > 0) parts.push(failed + ' basarisiz');
      if (reservePool.length === 0 && sent < dailyLimit) parts.push('havuz tukendi');
      WP.utils.showToast(parts.join(', '), sent > 0 ? 'success' : 'info');

    } catch (err) {
      WP.utils.showToast('Gonderim hatasi: ' + err.message, 'error');
    } finally {
      WP.state.contactScannerRunning = false;
      WP.state.contactScannerCancelled = false;
      WP.contactScanner._updateUI('idle');
    }
  },

  // --- Settings ---

  _getSelectedCategory() {
    const select = document.getElementById('contact-scanner-category-select');
    return select ? select.value : '__all__';
  },

  _getDailyLimit() {
    const input = document.getElementById('contact-scanner-daily-limit');
    const val = parseInt(input?.value, 10);
    if (isNaN(val) || val < 1) return WP.config.STORY_SCANNER.MAX_CONTACTS_PER_RUN;
    return Math.min(val, WP.config.STORY_SCANNER.MAX_DAILY_LIMIT);
  },

  _getInterContactDelay() {
    const input = document.getElementById('contact-scanner-delay');
    const val = parseInt(input?.value, 10);
    const min = WP.config.STORY_SCANNER.MIN_DELAY_SEC;
    if (isNaN(val) || val < min) return WP.config.STORY_SCANNER.DEFAULT_DELAY_SEC * 1000;
    return Math.min(val, WP.config.STORY_SCANNER.MAX_DELAY_SEC) * 1000;
  },

  _getExcludedLabels() {
    const input = document.getElementById('contact-scanner-excluded-labels');
    const val = (input?.value || '').trim();
    if (!val) return [];
    return val.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  },

  // --- UI ---

  _updateUI(state) {
    const bar = document.getElementById('contact-scanner-bar');
    const btn = document.getElementById('btn-contact-scan');
    const label = document.getElementById('contact-scanner-btn-label');
    const progress = document.getElementById('contact-scanner-progress');

    if (state === 'scanning') {
      bar.classList.add('active');
      btn.classList.add('scanning');
      btn.classList.remove('ready');
      label.textContent = 'Durdur';
      progress.classList.remove('hidden');
    } else {
      bar.classList.remove('active');
      btn.classList.remove('scanning');
      btn.classList.remove('ready');
      label.textContent = 'Rehberi Tara';
      progress.classList.add('hidden');
    }
  },

  _updateProgress(current, total, text) {
    const fill = document.getElementById('contact-scanner-progress-fill');
    const textEl = document.getElementById('contact-scanner-progress-text');

    if (total > 0) {
      fill.style.width = Math.round((current / total) * 100) + '%';
    } else {
      fill.style.width = '0%';
    }
    textEl.textContent = text;
  },

  populateCategorySelect() {
    const select = document.getElementById('contact-scanner-category-select');
    if (!select) return;

    while (select.options.length > 1) {
      select.remove(1);
    }

    const sorted = Array.from(WP.state.categories.keys()).sort();
    for (const name of sorted) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    }
  },

  toggleSettings() {
    document.getElementById('contact-scanner-settings').classList.toggle('hidden');
  },

  // Load/save excluded labels
  async loadSettings() {
    const result = await chrome.storage.local.get('contactScannerExcludedLabels');
    const input = document.getElementById('contact-scanner-excluded-labels');
    if (input && result.contactScannerExcludedLabels) {
      input.value = result.contactScannerExcludedLabels;
    }
  },

  async saveExcludedLabels() {
    const input = document.getElementById('contact-scanner-excluded-labels');
    if (input) {
      await chrome.storage.local.set({ contactScannerExcludedLabels: input.value });
    }
  },
};
