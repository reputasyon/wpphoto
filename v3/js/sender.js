// WPPhoto v3 - Photo sending orchestration
WP.sender = {

  // --- Public API ---

  async sendCategory(categoryName, btnElement) {
    if (WP.state.isSending) return;
    WP.state.isSending = true;

    const files = WP.state.categories.get(categoryName);
    if (!files || files.length === 0) {
      WP.utils.showToast('Bu kategoride fotograf yok', 'info');
      WP.state.isSending = false;
      return;
    }

    // Visual feedback on button
    btnElement.classList.add('sending');
    const countEl = btnElement.querySelector('.cat-count');
    const originalCount = countEl.textContent;
    countEl.innerHTML = '<div class="cat-spinner"></div>';

    try {
      const tab = await WP.tab.getWhatsAppTab();
      await WP.tab.ensureContentScript(tab);

      const batches = await WP.sender._splitHandlesIntoBatches(files);

      WP.ui.showSendProgress(categoryName + ' gonderiliyor...');

      for (let b = 0; b < batches.length; b++) {
        const isLast = b === batches.length - 1;

        // Wait for WhatsApp tab to be active before sending
        await WP.sender._waitForWhatsAppActive(tab);

        const { loaded, skipped } = await WP.sender._readBatch(batches[b]);

        if (loaded.length === 0) {
          if (isLast && b === 0) throw new Error('Hicbir dosya okunamadi');
          continue;
        }

        if (skipped > 0) {
          WP.utils.showToast(skipped + ' dosya atlandi', 'info');
        }

        if (batches.length > 1) {
          const msg = 'Grup ' + (b + 1) + '/' + batches.length + ' (' + loaded.length + ' foto)...';
          WP.utils.showToast(msg, 'info');
          WP.ui.updateSendProgress(msg);
        } else {
          WP.utils.showToast(loaded.length + ' fotograf gonderiliyor...', 'info');
        }

        const caption = isLast ? categoryName : null;
        await WP.sender._sendBatchToTab(tab, loaded, caption);

        // Wait between batches for WhatsApp to process
        if (!isLast) {
          await WP.utils.sleep(WP.config.WAIT.INTER_BATCH(loaded.length));
        }
      }

      WP.utils.showToast(files.length + ' foto gonderildi!', 'success');
      await WP.stats.track();
    } catch (err) {
      WP.utils.showToast('Gonderilemedi: ' + err.message, 'error');
    } finally {
      WP.state.isSending = false;
      btnElement.classList.remove('sending');
      countEl.textContent = originalCount;
      WP.ui.hideSendProgress();
    }
  },

  async sendAllCategories() {
    if (WP.state.isSending) return;
    if (WP.state.categories.size === 0) return;

    WP.state.isSending = true;
    WP.state.sendAllCancelled = false;

    const sendAllBtn = document.getElementById('btn-send-all');
    sendAllBtn.classList.add('sending');

    // Get DOM order of categories
    const categoryListEl = document.getElementById('category-list');
    const domOrder = Array.from(categoryListEl.querySelectorAll('.category-btn .cat-name'))
      .map(el => el.textContent);

    const allSorted = domOrder.filter(name => WP.state.categories.has(name));
    const sorted = WP.state.selectedCategories.size > 0
      ? allSorted.filter(name => WP.state.selectedCategories.has(name))
      : allSorted;

    const total = sorted.length;
    if (total === 0) {
      WP.state.isSending = false;
      sendAllBtn.classList.remove('sending');
      return;
    }

    let sent = 0;
    let failed = 0;

    WP.ui.showSendProgress('Tumunu gonderiliyor...');

    try {
      const tab = await WP.tab.getWhatsAppTab();
      await WP.tab.ensureContentScript(tab);

      for (let i = 0; i < sorted.length; i++) {
        if (WP.state.sendAllCancelled) {
          WP.utils.showToast('Gonderim iptal edildi (' + sent + '/' + total + ')', 'info');
          break;
        }

        const name = sorted[i];
        const files = WP.state.categories.get(name);

        // Update send-all label and progress with current category
        const progressText = (i + 1) + '/' + total + ' ' + name;
        WP.ui.updateSendAllButton(progressText);
        WP.ui.updateSendProgress(progressText + ' gonderiliyor...');
        WP.utils.showToast((i + 1) + '/' + total + ' - ' + name + ' gonderiliyor...', 'info');

        // Visual feedback on individual category button
        const btnElement = Array.from(categoryListEl.querySelectorAll('.category-btn'))
          .find(btn => btn.querySelector('.cat-name')?.textContent === name);
        if (btnElement) btnElement.classList.add('sending');

        try {
          const batches = await WP.sender._splitHandlesIntoBatches(files);

          let totalLoaded = 0;
          for (let b = 0; b < batches.length; b++) {
            if (WP.state.sendAllCancelled) break;

            const isLast = b === batches.length - 1;

            // Wait for WhatsApp tab to be active before each batch
            await WP.sender._waitForWhatsAppActive(tab);

            const { loaded, skipped } = await WP.sender._readBatch(batches[b]);

            if (loaded.length === 0) {
              if (isLast && b === 0) throw new Error('Hicbir dosya okunamadi');
              continue;
            }

            const caption = isLast ? name : null;
            await WP.sender._sendBatchToTab(tab, loaded, caption);
            totalLoaded += loaded.length;

            if (!isLast) {
              await WP.utils.sleep(WP.config.WAIT.INTER_BATCH(loaded.length));
            }
          }

          sent++;
          WP.utils.showToast((i + 1) + '/' + total + ' - ' + name + ' gonderildi', 'success');
          await WP.stats.track();
        } catch (err) {
          failed++;
          WP.utils.showToast(name + ' gonderilemedi: ' + err.message, 'error');
        }

        if (btnElement) btnElement.classList.remove('sending');

        // Wait between categories
        if (i < sorted.length - 1 && !WP.state.sendAllCancelled) {
          await WP.utils.sleep(WP.config.WAIT.INTER_CATEGORY);
        }
      }

      if (!WP.state.sendAllCancelled) {
        const msg = sent + ' kategori gonderildi' + (failed ? ', ' + failed + ' basarisiz' : '');
        WP.utils.showToast(msg, failed ? 'info' : 'success');
      }
    } catch (err) {
      WP.utils.showToast('Hata: ' + err.message, 'error');
    } finally {
      WP.state.isSending = false;
      WP.state.sendAllCancelled = false;
      sendAllBtn.classList.remove('sending');
      // Clear selections
      WP.state.selectedCategories.clear();
      document.querySelectorAll('.category-btn').forEach(b => b.classList.remove('selected'));
      WP.ui.updateSendAllButton();
      WP.ui.hideSendProgress();
    }
  },

  handleSendAllClick() {
    if (WP.state.isSending) {
      WP.state.sendAllCancelled = true;
      return;
    }
    WP.sender.sendAllCategories();
  },

  // --- Private helpers ---

  // Wait for WhatsApp tab to be the active tab (with timeout)
  async _waitForWhatsAppActive(tab) {
    const timeout = WP.config.WAIT.WHATSAPP_ACTIVE_TIMEOUT;
    const poll = WP.config.WAIT.WHATSAPP_ACTIVE_POLL;
    const startTime = Date.now();
    let warned = false;

    while (Date.now() - startTime < timeout) {
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab && activeTab.id === tab.id) return;
      } catch (e) {
        // Tab query failed, keep trying
      }

      if (!warned) {
        WP.utils.showToast('WhatsApp sekmesine donun - gonderim duraklatildi', 'info');
        warned = true;
      }
      await WP.utils.sleep(poll);
    }

    throw new Error('WhatsApp sekmesi 60 saniye icinde aktif edilmedi');
  },

  async _splitHandlesIntoBatches(files) {
    const items = [];
    for (const fileInfo of files) {
      try {
        const file = await fileInfo.handle.getFile();
        // Use raw file size (no base64 inflation in v3)
        items.push({ handle: fileInfo.handle, name: fileInfo.name, size: file.size });
      } catch (e) {
        console.warn('[WPPhoto] File size unreadable, skipping:', fileInfo.name);
      }
    }

    const batches = [];
    let current = [];
    let currentSize = 0;

    for (const item of items) {
      if (current.length > 0 && currentSize + item.size > WP.config.BATCH_MAX_BYTES) {
        batches.push(current);
        current = [];
        currentSize = 0;
      }
      current.push(item);
      currentSize += item.size;
    }
    if (current.length > 0) batches.push(current);

    return batches;
  },

  async _readBatch(handles) {
    const loaded = [];
    let skipped = 0;

    for (const item of handles) {
      try {
        const file = await item.handle.getFile();
        const buffer = await file.arrayBuffer();
        // Send raw ArrayBuffer - structured clone handles this natively
        loaded.push({
          buffer,
          fileName: file.name,
          mimeType: file.type || 'image/jpeg',
        });
      } catch (e) {
        skipped++;
        console.warn('[WPPhoto] File unreadable, skipping:', item.name, e.message);
      }
    }

    return { loaded, skipped };
  },

  async _sendBatchToTab(tab, files, caption) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tab.id, {
        action: 'SEND_PHOTOS_BATCH',
        data: { files, caption },
      }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response && response.success) {
          resolve(response);
        } else {
          reject(new Error(response?.error || 'Bilinmeyen hata'));
        }
      });
    });
  },
};
