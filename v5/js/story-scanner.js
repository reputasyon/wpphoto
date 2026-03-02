// WPPhoto v4 - Story Scanner: scan stories, filter contacts, send catalogs
WP.storyScanner = {

  _pendingTargets: null, // contacts waiting for user approval
  _allScannedContacts: null, // full list from scan (reserve pool for replacements)

  async startScan() {
    // If targets are pending approval, start sending
    if (WP.storyScanner._pendingTargets) {
      WP.storyScanner._startSending();
      return;
    }

    if (WP.state.isSending) {
      WP.utils.showToast('Gonderim devam ediyor, bekleyin', 'info');
      return;
    }
    if (WP.state.storyScannerRunning) {
      WP.state.storyScannerCancelled = true;
      return;
    }

    WP.state.storyScannerRunning = true;
    WP.state.storyScannerCancelled = false;
    WP.storyScanner._updateUI('scanning');

    try {
      const tab = await WP.tab.getWhatsAppTab();
      await WP.tab.ensureContentScript(tab);

      // --- Phase 1: Scan stories ---
      WP.storyScanner._updateProgress(0, 0, 'Hikayeler taraniyor...');

      const scanResult = await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tab.id, { action: 'SCAN_STORY_CONTACTS' }, response => {
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
        WP.utils.showToast('Hikaye bulunamadi', 'info');
        return;
      }

      console.log('[WPPhoto] Hikaye paylasanlar: ' + scanResult.length + ' kisi');

      // --- Phase 2: Apply daily limit and show preview ---
      const dailyLimit = WP.storyScanner._getDailyLimit();
      const targets = scanResult.slice(0, dailyLimit);

      WP.storyScanner._allScannedContacts = scanResult;
      WP.storyScanner._pendingTargets = targets;
      WP.storyScanner._showPreview(targets, scanResult.length);

    } catch (err) {
      WP.utils.showToast('Tarama hatasi: ' + err.message, 'error');
    } finally {
      WP.state.storyScannerRunning = false;
      // Only reset UI if preview is NOT shown (don't overwrite "Secilenleri Gonder")
      if (!WP.storyScanner._pendingTargets) {
        WP.storyScanner._updateUI('idle');
      }
    }
  },

  // Show scanned contacts for user review before sending
  _showPreview(targets, totalScanned) {
    const previewEl = document.getElementById('scanner-preview');
    const listEl = document.getElementById('scanner-preview-list');
    const infoEl = document.getElementById('scanner-preview-info');

    // Build contact list with checkboxes
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

    infoEl.textContent =
      totalScanned + ' hikaye bulundu, ' + targets.length + ' kisi listelendi';

    previewEl.classList.remove('hidden');

    // Update button to "Gonder" mode
    const btn = document.getElementById('btn-story-scan');
    const label = document.getElementById('scanner-btn-label');
    btn.classList.add('ready');
    btn.classList.remove('scanning');
    label.textContent = 'Secilenleri Gonder';

    // Hide progress
    document.getElementById('scanner-progress').classList.add('hidden');
  },

  _cancelPreview() {
    WP.storyScanner._pendingTargets = null;
    WP.storyScanner._allScannedContacts = null;
    document.getElementById('scanner-preview').classList.add('hidden');
    WP.storyScanner._updateUI('idle');
    WP.utils.showToast('Iptal edildi', 'info');
  },

  async _startSending() {
    // Get checked contacts from preview
    const checkboxes = document.querySelectorAll('#scanner-preview-list input[type="checkbox"]');
    const selectedTargets = [];
    for (const cb of checkboxes) {
      if (cb.checked) selectedTargets.push(cb.value);
    }

    // Build reserve pool: all scanned contacts NOT in selectedTargets
    const selectedSet = new Set(selectedTargets);
    const reservePool = (WP.storyScanner._allScannedContacts || [])
      .filter(name => !selectedSet.has(name));

    WP.storyScanner._pendingTargets = null;
    WP.storyScanner._allScannedContacts = null;
    document.getElementById('scanner-preview').classList.add('hidden');

    if (selectedTargets.length === 0) {
      WP.utils.showToast('Hic kisi secilmedi', 'info');
      WP.storyScanner._updateUI('idle');
      return;
    }

    if (WP.state.isSending) {
      WP.utils.showToast('Gonderim devam ediyor, bekleyin', 'info');
      WP.storyScanner._updateUI('idle');
      return;
    }

    WP.state.storyScannerRunning = true;
    WP.state.storyScannerCancelled = false;
    WP.storyScanner._updateUI('scanning');

    try {
      const tab = await WP.tab.getWhatsAppTab();
      await WP.tab.ensureContentScript(tab);

      const categoryToSend = WP.storyScanner._getSelectedCategory();
      const dailyLimit = WP.storyScanner._getDailyLimit();
      let sent = 0;
      let skipped = 0;
      let failed = 0;
      let tried = 0;
      const interContactDelay = WP.storyScanner._getInterContactDelay();

      // Queue: start with selected, pull from reserve when skipped/failed
      const queue = [...selectedTargets];

      while (queue.length > 0 && sent < dailyLimit && !WP.state.storyScannerCancelled) {
        const contactName = queue.shift();
        tried++;

        WP.storyScanner._updateProgress(sent, dailyLimit,
          contactName + ' aciliyor... (' + sent + '/' + dailyLimit + ')');

        // 1. Switch to contact's chat
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
          // Pull replacement from reserve
          if (reservePool.length > 0) {
            const replacement = reservePool.shift();
            queue.push(replacement);
            console.log('[WPPhoto] Acilamadi, yedekten ekleniyor: ' + replacement);
          }
          await WP.utils.sleep(2000);
          continue;
        }

        await WP.utils.sleep(WP.config.STORY_SCANNER.CHAT_SETTLE);

        // 2. Check ACTUAL WhatsApp chat history — skip if messaged in last 30 days
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
          console.log('[WPPhoto] ATLANDI (son 30 gun mesaj var): ' + contactName + ' (' + recency.reason + ')');
          WP.storyScanner._updateProgress(sent, dailyLimit,
            contactName + ' atlandi (son 30 gun)');
          WP.utils.showToast(contactName + ' atlandi - son 30 gunde mesajlasilmis', 'info');
          // Pull replacement from reserve
          if (reservePool.length > 0) {
            const replacement = reservePool.shift();
            queue.push(replacement);
            console.log('[WPPhoto] Atlandi, yedekten ekleniyor: ' + replacement);
          }
          await WP.utils.sleep(2000);
          continue;
        }

        // 3. Send photos
        WP.storyScanner._updateProgress(sent, dailyLimit,
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
          // Pull replacement from reserve
          if (reservePool.length > 0) {
            const replacement = reservePool.shift();
            queue.push(replacement);
            console.log('[WPPhoto] Gonderilemedi, yedekten ekleniyor: ' + replacement);
          }
        }

        // Wait between contacts
        if (queue.length > 0 && sent < dailyLimit && !WP.state.storyScannerCancelled) {
          WP.storyScanner._updateProgress(sent, dailyLimit,
            'Bekleniyor (' + (interContactDelay / 1000) + 's)...');
          await WP.utils.sleep(interContactDelay);
        }
      }

      if (WP.state.storyScannerCancelled) {
        WP.utils.showToast('Iptal edildi (' + sent + '/' + dailyLimit + ')', 'info');
      }

      const parts = [];
      if (sent > 0) parts.push(sent + ' gonderildi');
      if (skipped > 0) parts.push(skipped + ' atlandi');
      if (failed > 0) parts.push(failed + ' basarisiz');
      if (reservePool.length === 0 && sent < dailyLimit) parts.push('havuz tukendi');
      WP.utils.showToast(parts.join(', '), sent > 0 ? 'success' : 'info');

    } catch (err) {
      WP.utils.showToast('Gonderim hatasi: ' + err.message, 'error');
    } finally {
      WP.state.storyScannerRunning = false;
      WP.state.storyScannerCancelled = false;
      WP.storyScanner._updateUI('idle');
    }
  },

  // --- Photo sending helpers ---

  async _sendCategoryToCurrentChat(tab, categoryName) {
    let matchedName = null;
    for (const name of WP.state.categories.keys()) {
      if (name.toLowerCase() === categoryName.toLowerCase()) {
        matchedName = name;
        break;
      }
    }
    if (!matchedName) throw new Error('Kategori bulunamadi: ' + categoryName);

    const files = WP.state.categories.get(matchedName);
    if (!files || files.length === 0) throw new Error('Kategoride foto yok');

    const batches = await WP.sender._splitHandlesIntoBatches(files);

    for (let b = 0; b < batches.length; b++) {
      const isLast = b === batches.length - 1;
      await WP.sender._waitForWhatsAppActive(tab);

      const { loaded } = await WP.sender._readBatch(batches[b]);
      if (loaded.length === 0) {
        if (isLast && b === 0) throw new Error('Dosya okunamadi');
        continue;
      }

      const caption = isLast ? matchedName : null;
      await WP.sender._sendBatchToTab(tab, loaded, caption);

      if (!isLast) {
        await WP.utils.sleep(WP.config.WAIT.INTER_BATCH(loaded.length));
      }
    }
  },

  async _sendAllToCurrentChat(tab) {
    const categoryListEl = document.getElementById('category-list');
    const domOrder = Array.from(categoryListEl.querySelectorAll('.category-btn .cat-name'))
      .map(el => el.textContent);
    const sorted = domOrder.filter(name => WP.state.categories.has(name));

    for (let i = 0; i < sorted.length; i++) {
      const name = sorted[i];
      const files = WP.state.categories.get(name);
      if (!files || files.length === 0) continue;

      const batches = await WP.sender._splitHandlesIntoBatches(files);

      for (let b = 0; b < batches.length; b++) {
        const isLast = b === batches.length - 1;
        await WP.sender._waitForWhatsAppActive(tab);

        const { loaded } = await WP.sender._readBatch(batches[b]);
        if (loaded.length === 0) continue;

        const caption = isLast ? name : null;
        await WP.sender._sendBatchToTab(tab, loaded, caption);

        if (!isLast) {
          await WP.utils.sleep(WP.config.WAIT.INTER_BATCH(loaded.length));
        }
      }

      if (i < sorted.length - 1) {
        await WP.utils.sleep(WP.config.WAIT.INTER_CATEGORY);
      }
    }
  },

  // --- Settings helpers ---

  _getSelectedCategory() {
    const select = document.getElementById('scanner-category-select');
    return select ? select.value : '__all__';
  },

  _getDailyLimit() {
    const input = document.getElementById('scanner-daily-limit');
    const val = parseInt(input?.value, 10);
    if (isNaN(val) || val < 1) return WP.config.STORY_SCANNER.MAX_CONTACTS_PER_RUN;
    return Math.min(val, WP.config.STORY_SCANNER.MAX_DAILY_LIMIT);
  },

  _getInterContactDelay() {
    const input = document.getElementById('scanner-delay');
    const val = parseInt(input?.value, 10);
    const min = WP.config.STORY_SCANNER.MIN_DELAY_SEC;
    if (isNaN(val) || val < min) return WP.config.STORY_SCANNER.DEFAULT_DELAY_SEC * 1000;
    return Math.min(val, WP.config.STORY_SCANNER.MAX_DELAY_SEC) * 1000;
  },

  // --- UI helpers ---

  _updateUI(state) {
    const bar = document.getElementById('story-scanner-bar');
    const btn = document.getElementById('btn-story-scan');
    const label = document.getElementById('scanner-btn-label');
    const progress = document.getElementById('scanner-progress');

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
      label.textContent = 'Hikayeleri Tara';
      progress.classList.add('hidden');
    }
  },

  _updateProgress(current, total, text) {
    const fill = document.getElementById('scanner-progress-fill');
    const textEl = document.getElementById('scanner-progress-text');

    if (total > 0) {
      fill.style.width = Math.round((current / total) * 100) + '%';
    } else {
      fill.style.width = '0%';
    }
    textEl.textContent = text;
  },

  populateCategorySelect() {
    const select = document.getElementById('scanner-category-select');
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
    document.getElementById('scanner-settings').classList.toggle('hidden');
  },
};
