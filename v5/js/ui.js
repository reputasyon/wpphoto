// WPPhoto v3 - Category button rendering (XSS-safe) + send progress UI
WP.ui = {

  renderCategoryButtons() {
    const listEl = document.getElementById('category-list');
    listEl.innerHTML = '';
    WP.state.selectedCategories.clear();

    const sorted = WP.ui._getSortedCategories();

    for (const [name, files] of sorted) {
      const btn = document.createElement('button');
      btn.className = 'category-btn';

      // Static HTML structure only - no dynamic data in innerHTML
      btn.innerHTML = WP.ui._buildButtonHTML();

      // XSS-safe: set dynamic text via DOM API, not innerHTML
      btn.querySelector('.cat-name').textContent = name;
      btn.querySelector('.cat-count').textContent = files.length + ' foto';

      // Checkbox click = selection toggle
      btn.querySelector('.cat-check').addEventListener('click', (e) => {
        e.stopPropagation();
        WP.ui._toggleSelection(name, btn);
      });

      // Arrow buttons for reordering
      btn.querySelector('.arrow-up').addEventListener('click', (e) => {
        e.stopPropagation();
        WP.ui._moveCategoryUp(btn);
      });

      btn.querySelector('.arrow-down').addEventListener('click', (e) => {
        e.stopPropagation();
        WP.ui._moveCategoryDown(btn);
      });

      // Button click = send single category
      btn.addEventListener('click', () => WP.sender.sendCategory(name, btn));
      listEl.appendChild(btn);
    }

    WP.ui.updateSendAllButton();
  },

  _buildButtonHTML() {
    return '<div class="cat-check"><span class="check-box"></span></div>' +
      '<div class="cat-left">' +
        '<div class="cat-icon">' +
          '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>' +
          '</svg>' +
        '</div>' +
        '<span class="cat-name"></span>' +
      '</div>' +
      '<div class="cat-right">' +
        '<span class="cat-count"></span>' +
        '<div class="cat-arrows">' +
          '<span class="arrow-btn arrow-up" title="Yukari">&#9650;</span>' +
          '<span class="arrow-btn arrow-down" title="Asagi">&#9660;</span>' +
        '</div>' +
      '</div>';
  },

  updateSendAllButton(customText) {
    const label = document.getElementById('send-all-label');
    if (customText) {
      label.textContent = customText;
    } else if (WP.state.selectedCategories.size > 0) {
      label.textContent = 'Secilenleri Gonder (' + WP.state.selectedCategories.size + ')';
    } else {
      label.textContent = 'Tumunu Gonder';
    }
  },

  // --- Send progress UI (v3: now functional) ---

  showSendProgress(text) {
    const el = document.getElementById('send-progress');
    const textEl = document.getElementById('send-progress-text');
    textEl.textContent = text || 'Gonderiliyor...';
    el.classList.remove('hidden');
    document.getElementById('category-list').classList.add('hidden');
  },

  hideSendProgress() {
    document.getElementById('send-progress').classList.add('hidden');
    document.getElementById('category-list').classList.remove('hidden');
  },

  updateSendProgress(text) {
    document.getElementById('send-progress-text').textContent = text;
  },

  // --- Private helpers ---

  _toggleSelection(name, btn) {
    if (WP.state.selectedCategories.has(name)) {
      WP.state.selectedCategories.delete(name);
      btn.classList.remove('selected');
    } else {
      WP.state.selectedCategories.add(name);
      btn.classList.add('selected');
    }
    WP.ui.updateSendAllButton();
  },

  _moveCategoryUp(btn) {
    const prev = btn.previousElementSibling;
    if (prev) {
      document.getElementById('category-list').insertBefore(btn, prev);
      WP.ui._saveCategoryOrder();
    }
  },

  _moveCategoryDown(btn) {
    const next = btn.nextElementSibling;
    if (next) {
      document.getElementById('category-list').insertBefore(next, btn);
      WP.ui._saveCategoryOrder();
    }
  },

  _getSortedCategories() {
    const entries = Array.from(WP.state.categories.entries());
    const order = WP.state.categoryOrder;

    if (order.length > 0) {
      entries.sort((a, b) => {
        const idxA = order.indexOf(a[0]);
        const idxB = order.indexOf(b[0]);
        if (idxA === -1 && idxB === -1) return a[0].localeCompare(b[0]);
        if (idxA === -1) return 1;
        if (idxB === -1) return -1;
        return idxA - idxB;
      });
    } else {
      entries.sort((a, b) => a[0].localeCompare(b[0]));
    }

    return entries;
  },

  async _saveCategoryOrder() {
    const btns = document.getElementById('category-list').querySelectorAll('.category-btn');
    WP.state.categoryOrder = Array.from(btns).map(b => b.querySelector('.cat-name').textContent);
    await chrome.storage.local.set({ categoryOrder: WP.state.categoryOrder });
  },

  async _loadCategoryOrder() {
    const result = await chrome.storage.local.get('categoryOrder');
    WP.state.categoryOrder = result.categoryOrder || [];
  },
};
