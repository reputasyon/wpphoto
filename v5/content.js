// WPPhoto v4 - Content Script (WhatsApp Web)
// Injected into web.whatsapp.com - handles photo sending, trigger detection, chat navigation, story scanning

if (window.__wpphoto_loaded) {
  console.log('[WPPhoto] Content script already loaded, skipping init');
} else {
  window.__wpphoto_loaded = true;

  // =========================================================
  // Constants (local - content scripts cannot import ES modules)
  // =========================================================
  const TRIGGER_COOLDOWN_MS = 5 * 60 * 1000;
  const CHAT_SWITCH_GRACE_MS = 9000;
  const SEEN_MESSAGES_CLEAR_MS = 5 * 60 * 1000;
  const CHAT_NAME_MIN_MATCH = 3;

  const SELECTORS = {
    chatPane: ['#main', '[data-testid="conversation-panel-wrapper"]'],
    composeInput: [
      '[data-testid="conversation-compose-box-input"]',
      'div[contenteditable="true"][data-tab="10"]',
      'footer div[contenteditable="true"]',
    ],
  };

  // WhatsApp Web Status/Stories tab selectors (multi-fallback for resilience)
  const STATUS_SELECTORS = {
    statusTabBtn: [
      '[data-testid="status-v3-tab"]',
      '[data-testid="tab-status"]',
      '[data-testid="updates-tab"]',
      'button[aria-label="Status"]',
      'button[aria-label="Durum"]',
      'button[aria-label="Güncellemeler"]',
      'button[aria-label="Updates"]',
      'span[data-icon="status-v3"]',
      'span[data-icon="status-v3-unread"]',
      'span[data-icon="status-outline"]',
      'span[data-icon="status-unread-outline"]',
      'span[data-icon="updates"]',
      'span[data-icon="updates-unread"]',
    ],
    backToChats: [
      'button[aria-label="Sohbetler"]',
      'button[aria-label="Chats"]',
      'span[data-icon="chat-filled-refreshed"]',
      'span[data-icon="chat-filled"]',
      'span[data-icon="chat"]',
      '[data-testid="default-tab"]',
      '[data-testid="tab-chat"]',
      '[data-testid="chat-tab"]',
      '[data-testid="btn-back"]',
      'span[data-icon="back"]',
    ],
  };

  // =========================================================
  // State
  // =========================================================
  let autoModeEnabled = false;
  let sidebarSwitching = false;
  let lastChatName = null;
  let chatSwitchTime = 0;
  const processedTriggers = new Map();  // "chatName:#category" -> timestamp
  let seenMessages = new Set();         // "context:chatName:text" dedup
  const triggerQueue = [];              // { chatName, category }
  let processingTrigger = false;

  // MutationObserver state
  let scanDebounceTimer = null;
  let mainObserver = null;
  let sideObserver = null;
  let mainObserverTarget = null;
  let sideObserverTarget = null;

  // Load saved auto-mode state
  chrome.storage.local.get('autoMode', result => {
    autoModeEnabled = result.autoMode || false;
    console.log('[WPPhoto] Auto mode init: ' + (autoModeEnabled ? 'ON' : 'OFF'));
  });

  // =========================================================
  // Utility functions
  // =========================================================
  function querySelector(selectorList) {
    for (const sel of selectorList) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function base64ToFile(base64, fileName, mimeType) {
    const byteChars = atob(base64);
    const byteArray = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) {
      byteArray[i] = byteChars.charCodeAt(i);
    }
    return new File([byteArray], fileName, { type: mimeType });
  }

  function findCaptionInput() {
    const composeBox = querySelector(SELECTORS.composeInput);

    // 1. Known media caption selectors
    const selectors = [
      '[data-testid="media-caption-input"] [contenteditable="true"]',
      '[data-testid="media-caption-input-container"] [contenteditable="true"]',
      '[data-testid="media-editor"] [contenteditable="true"]',
      '[data-testid="media-editor-container"] [contenteditable="true"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        console.log('[WPPhoto] Caption input found (selector): ' + sel);
        return el;
      }
    }

    // 2. Fallback: visible contenteditable that is NOT the compose box
    const allEditable = document.querySelectorAll('[contenteditable="true"]');
    for (const el of allEditable) {
      if (el === composeBox) continue;
      if (el.getAttribute('data-tab') === '10') continue;
      if (el.closest('#side')) continue;
      if (el.offsetHeight === 0) continue;

      const placeholder = el.getAttribute('data-placeholder')
        || el.getAttribute('title')
        || el.closest('[data-placeholder]')?.getAttribute('data-placeholder')
        || '';
      console.log('[WPPhoto] Candidate contenteditable: height=' + el.offsetHeight + ' placeholder="' + placeholder + '"');
      return el;
    }

    console.warn('[WPPhoto] No caption input found');
    return null;
  }

  function pressEnter(target) {
    const el = target
      || querySelector(SELECTORS.composeInput)
      || document.activeElement
      || document.body;
    if (el && el.focus) el.focus();

    const opts = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  function getCurrentChatName() {
    const header = document.querySelector('#main header');
    if (!header) return null;
    const nameSpan = header.querySelector('span[dir="auto"]');
    return nameSpan ? nameSpan.textContent.trim() : null;
  }

  // =========================================================
  // Chat recency check — reads ACTUAL WhatsApp message dates
  // =========================================================
  function hasRecentMessages(daysThreshold) {
    const mainEl = document.querySelector('#main');
    if (!mainEl) return { hasRecent: false, reason: 'no-main-panel' };

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysThreshold);
    cutoff.setHours(0, 0, 0, 0);

    // Strategy 1: Parse [data-pre-plain-text] attributes on messages
    // Format: "[14:30, 01.03.2026] Contact Name: " or "[2:45 PM, 3/1/2026] ..."
    const prePlainTexts = mainEl.querySelectorAll('[data-pre-plain-text]');
    if (prePlainTexts.length > 0) {
      // Check the LAST message (most recent)
      const lastMsg = prePlainTexts[prePlainTexts.length - 1];
      const raw = lastMsg.getAttribute('data-pre-plain-text') || '';
      const dateMatch = raw.match(/\[[\d:.\s]+[APMapm]*,\s*(\d{1,2})[./](\d{1,2})[./](\d{4})\]/);
      if (dateMatch) {
        const day = parseInt(dateMatch[1], 10);
        const month = parseInt(dateMatch[2], 10) - 1;
        const year = parseInt(dateMatch[3], 10);
        const msgDate = new Date(year, month, day);
        const isRecent = msgDate >= cutoff;
        console.log('[WPPhoto] Recency (pre-plain-text): date=' + msgDate.toLocaleDateString() + ' recent=' + isRecent);
        return { hasRecent: isRecent, reason: 'pre-plain-text', date: msgDate.toISOString() };
      }
    }

    // Strategy 2: Check date separator/divider texts
    // WhatsApp shows "BUGÜN", "DÜN", "27.02.2026", "YESTERDAY", "TODAY", etc.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    // Find all visible text that looks like a date separator
    const allSpans = mainEl.querySelectorAll('span');
    let lastFoundDate = null;

    for (const span of allSpans) {
      if (span.offsetHeight === 0) continue;
      const text = span.textContent.trim().toUpperCase();

      // Today/Yesterday keywords
      if (text === 'BUGÜN' || text === 'TODAY') {
        lastFoundDate = today;
      } else if (text === 'DÜN' || text === 'YESTERDAY') {
        lastFoundDate = yesterday;
      } else {
        // Try DD.MM.YYYY or DD/MM/YYYY format
        const dateMatch = text.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
        if (dateMatch) {
          const day = parseInt(dateMatch[1], 10);
          const month = parseInt(dateMatch[2], 10) - 1;
          const year = parseInt(dateMatch[3], 10);
          const parsed = new Date(year, month, day);
          if (!isNaN(parsed.getTime())) {
            lastFoundDate = parsed;
          }
        }
      }
    }

    if (lastFoundDate) {
      // Date separator found — but verify there are ACTUAL messages
      // WhatsApp shows "Bugün" + encryption notice even in empty chats
      const hasRealMessages = mainEl.querySelectorAll('[data-pre-plain-text]').length > 0;
      if (!hasRealMessages) {
        console.log('[WPPhoto] Recency (date-separator but no messages): empty chat, date=' + lastFoundDate.toLocaleDateString());
        return { hasRecent: false, reason: 'empty-chat-with-date' };
      }
      const isRecent = lastFoundDate >= cutoff;
      console.log('[WPPhoto] Recency (date-separator): date=' + lastFoundDate.toLocaleDateString() + ' recent=' + isRecent);
      return { hasRecent: isRecent, reason: 'date-separator', date: lastFoundDate.toISOString() };
    }

    // Strategy 3: If there are ANY message rows visible, assume recent
    // (WhatsApp only loads recent messages by default)
    const messageRows = mainEl.querySelectorAll('[data-pre-plain-text]');
    if (messageRows.length > 0) {
      console.log('[WPPhoto] Recency (has-messages): ' + messageRows.length + ' messages found, assuming recent');
      return { hasRecent: true, reason: 'has-messages' };
    }

    // No messages found — empty chat or new contact
    console.log('[WPPhoto] Recency: no messages found');
    return { hasRecent: false, reason: 'empty-chat' };
  }

  function getChatNameFromSidebar(span) {
    let el = span.parentElement;
    while (el && el !== document.body) {
      const nameSpan = el.querySelector('span[dir="auto"][title]');
      if (nameSpan) return nameSpan.getAttribute('title') || nameSpan.textContent.trim();
      if (el.getAttribute('data-testid') === 'cell-frame-container') break;
      if (el.getAttribute('role') === 'listitem') break;
      if (el.getAttribute('role') === 'row') break;
      el = el.parentElement;
    }
    return null;
  }

  // =========================================================
  // Photo batch sending
  // =========================================================
  async function handleSendPhotosBatch({ files, caption }) {
    const chatPane = querySelector(SELECTORS.chatPane);
    if (!chatPane) throw new Error('Bir sohbet acin ve tekrar deneyin');

    const fileObjects = files.map(f => base64ToFile(f.base64, f.fileName, f.mimeType));

    const composeBox = querySelector(SELECTORS.composeInput);
    if (composeBox) composeBox.focus();
    await sleep(300); // COMPOSE_FOCUS

    // Build DataTransfer with all files
    const dt = new DataTransfer();
    for (const file of fileObjects) {
      dt.items.add(file);
    }

    (composeBox || document).dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    }));

    console.log('[WPPhoto] Paste dispatched, ' + fileObjects.length + ' files');
    await sleep(3000); // PASTE_SETTLE

    // Find caption input (media preview should be open)
    let captionInput = null;
    for (let i = 0; i < 5; i++) { // CAPTION_RETRIES
      captionInput = findCaptionInput();
      if (captionInput) break;
      await sleep(500); // CAPTION_RETRY
    }
    console.log('[WPPhoto] Caption input: ' + (captionInput ? 'found' : 'not found'));

    // If no caption input found, paste likely failed
    if (!captionInput) {
      console.error('[WPPhoto] Media preview did not open - paste failed');
      throw new Error('Fotograflar yapistirilmadi - media preview acilmadi');
    }

    captionInput.focus();
    await sleep(300); // CAPTION_FOCUS

    // Send: try 3 methods in order
    let sent = false;

    // 1. Click send button via MAIN world script
    console.log('[WPPhoto] Looking for send button (MAIN world)...');
    const sendResult = await new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'CLICK_SEND_BUTTON' }, response => {
        resolve(response);
      });
    });
    if (sendResult?.success) {
      console.log('[WPPhoto] Send button clicked: ' + sendResult.selector);
      sent = true;
    }

    // 2. Debugger Enter (focus should be on caption input)
    if (!sent) {
      console.log('[WPPhoto] Send button not found, trying debugger Enter...');
      if (captionInput) {
        captionInput.focus();
        await sleep(200);
      }
      const debugResult = await new Promise(resolve => {
        chrome.runtime.sendMessage({ action: 'PRESS_ENTER_DEBUGGER' }, response => {
          resolve(response);
        });
      });
      if (debugResult?.success) {
        console.log('[WPPhoto] Debugger Enter sent');
        sent = true;
      }
    }

    // 3. Last fallback: local Enter key events
    if (!sent) {
      console.log('[WPPhoto] Debugger failed, trying local Enter...');
      if (captionInput) captionInput.focus();
      await sleep(300);
      pressEnter(captionInput);
    }

    await sleep(3000); // SEND_SETTLE

    // Check if media preview is still open (send failed)
    const stillOpen = findCaptionInput();
    if (stillOpen) {
      console.warn('[WPPhoto] Media preview still open - photos not sent');
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true,
      }));
      throw new Error('Fotograflar gonderilemedi - gonder butonu calismadi');
    }

    console.log('[WPPhoto] Photos sent');

    // Send caption as separate text message after photos
    if (caption) {
      await sleep(1500);
      console.log('[WPPhoto] Sending caption text: ' + caption);
      await sendTextMessage(caption);
    }
  }

  // =========================================================
  // Text message sending (v3: with debugger fallback)
  // =========================================================
  async function sendTextMessage(text) {
    const composeBox = querySelector(SELECTORS.composeInput);
    if (!composeBox) {
      console.warn('[WPPhoto] Compose box not found');
      return;
    }

    composeBox.focus();
    await sleep(500); // TEXT_FOCUS

    document.execCommand('insertText', false, text);
    await sleep(500); // TEXT_SEND

    // Method 1: Local pressEnter
    pressEnter(composeBox);
    await sleep(1000); // TEXT_VERIFY

    // Check if message was sent (compose box should be empty after send)
    const boxText = composeBox.textContent.trim();
    if (!boxText) {
      console.log('[WPPhoto] Text message sent via local Enter');
      return;
    }

    // Method 2: Debugger Enter fallback
    console.log('[WPPhoto] Local Enter did not send text, trying debugger Enter...');
    composeBox.focus();
    await sleep(200);
    const debugResult = await new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'PRESS_ENTER_DEBUGGER' }, response => {
        resolve(response);
      });
    });
    if (debugResult?.success) {
      console.log('[WPPhoto] Text message sent via debugger Enter');
    } else {
      console.warn('[WPPhoto] Debugger Enter also failed for text message');
    }
    await sleep(500);
  }

  // =========================================================
  // Chat navigation via search
  // =========================================================
  function findSearchBox() {
    // NEVER use document.activeElement — it may return compose box
    // Always query DOM explicitly within #side, excluding #main and footer
    const selectors = [
      '#side [contenteditable="true"][data-tab]',
      '#side [role="textbox"][contenteditable="true"]',
      '#side p[contenteditable="true"]',
      '#side [contenteditable="true"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && !el.closest('#main') && !el.closest('footer') && el.offsetHeight > 0) {
        return el;
      }
    }
    return null;
  }

  async function switchToChatViaSearch(contactName) {
    const prevChat = getCurrentChatName();
    console.log('[WPPhoto] switchToChat: "' + contactName + '" (prevChat: ' + prevChat + ')');

    // 1. ALWAYS close search first (ensures fresh empty search box)
    const openBox = findSearchBox();
    if (openBox) {
      openBox.focus();
      openBox.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true,
      }));
      await sleep(600);
    }

    // 2. Find and click search icon to open fresh search
    let searchIcon = document.querySelector('span[data-icon="search-refreshed-thin"]')?.closest('button')
      || document.querySelector('span[data-icon="search"]')?.closest('button')
      || document.querySelector('button[aria-label="Ara"]');
    if (!searchIcon) {
      console.warn('[WPPhoto] Search icon not found');
      return false;
    }

    searchIcon.click();
    await sleep(1000);

    // 3. Find search box via DOM query (never activeElement)
    const searchBox = findSearchBox();
    if (!searchBox) {
      console.warn('[WPPhoto] Search box not found');
      return false;
    }

    // 4. Click search box via debugger to ensure trusted focus, then type
    const boxRect = searchBox.getBoundingClientRect();
    const bx = Math.round(boxRect.left + boxRect.width / 2);
    const by = Math.round(boxRect.top + boxRect.height / 2);
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'DEBUGGER_CLICK', x: bx, y: by }, () => resolve());
    });
    await sleep(500);

    // Type via chrome.debugger (trusted input that React picks up)
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'DEBUGGER_TYPE', text: contactName }, () => resolve());
    });
    await sleep(2000);
    console.log('[WPPhoto] box: "' + searchBox.textContent + '"');

    // 5. Find the search result element and click it via chrome.debugger (trusted click)
    let resultEl = null;

    // Find by span[title] match
    const titledSpans = document.querySelectorAll('#side span[title]');
    for (const span of titledSpans) {
      if (span.closest('[contenteditable]')) continue;
      const title = (span.getAttribute('title') || '').toLowerCase();
      const c = contactName.toLowerCase();
      if (title === c || title.includes(c) || c.includes(title)) {
        resultEl = span.closest('[role="listitem"]') || span.closest('[tabindex]') || span;
        console.log('[WPPhoto] Found result by title: "' + span.getAttribute('title') + '"');
        break;
      }
    }

    // Fallback: find by textContent match
    if (!resultEl) {
      const allSpans = document.querySelectorAll('#side span');
      for (const span of allSpans) {
        if (span.closest('[contenteditable]')) continue;
        const text = span.textContent.trim();
        if (!text || text.length < 3) continue;
        const t = text.toLowerCase();
        const c = contactName.toLowerCase();
        if (t === c || t.includes(c) || c.includes(t)) {
          if (span.closest('button') && !span.closest('[role="listitem"]')) continue;
          resultEl = span.closest('[role="listitem"]') || span.closest('[tabindex]') || span;
          console.log('[WPPhoto] Found result by text: "' + text + '"');
          break;
        }
      }
    }

    if (resultEl) {
      // Use chrome.debugger to send a TRUSTED click at the element's coordinates
      const rect = resultEl.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      console.log('[WPPhoto] Sending trusted click at (' + x + ', ' + y + ')');
      try {
        await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: 'DEBUGGER_CLICK', x, y }, () => resolve());
        });
      } catch (e) {
        console.warn('[WPPhoto] Debugger click failed: ' + e.message);
      }
    } else {
      console.warn('[WPPhoto] No search result found for: ' + contactName);
    }
    await sleep(500);

    // 6. Wait for chat to switch (max 5s)
    let switched = false;
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      const nowChat = getCurrentChatName();
      if (nowChat && nowChat !== prevChat) {
        console.log('[WPPhoto] Chat opened: ' + nowChat);
        const intended = contactName.toLowerCase();
        const actual = nowChat.toLowerCase();
        if (actual === intended) { switched = true; break; }
        const minLen = Math.min(actual.length, intended.length);
        if (minLen >= CHAT_NAME_MIN_MATCH && (actual.includes(intended) || intended.includes(actual))) {
          switched = true; break;
        }
        console.warn('[WPPhoto] Chat mismatch: wanted "' + contactName + '" got "' + nowChat + '"');
        break;
      }
    }

    if (!switched) {
      console.warn('[WPPhoto] Failed to open: ' + contactName);
    }
    return switched;
  }

  // =========================================================
  // Story contacts scanning
  // =========================================================

  // =========================================================
  // Contact List Scanner — scan all contacts via "New Chat" button
  // =========================================================
  async function scanContactList() {
    // 1. Find and click "New Chat" button
    const newChatSelectors = [
      'span[data-icon="new-chat-outline"]',
      'span[data-icon="chat-refresh"]',
      'span[data-icon="new-chat"]',
      'button[aria-label="Yeni sohbet"]',
      'button[aria-label="New chat"]',
      'button[aria-label="Yeni sohbet başlat"]',
      '[data-testid="menu-bar-new-chat"]',
    ];

    let newChatBtn = null;
    for (const sel of newChatSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        newChatBtn = el.closest('button') || el;
        break;
      }
    }
    if (!newChatBtn) throw new Error('Yeni sohbet butonu bulunamadi');

    console.log('[WPPhoto] Clicking New Chat button...');
    newChatBtn.click();
    await sleep(2000);

    // 2. Scrape contacts from the panel
    const names = new Set();
    const SKIP_NAMES = new Set([
      'My Status', 'Durumum', 'My status', 'Durum güncellemem',
      'Status', 'Durum', 'Güncellemeler', 'Updates',
      'Kanallar', 'Channels', 'WhatsApp', 'Meta',
      'Yeni grup', 'New group', 'Yeni topluluk', 'New community',
      'Aratın veya yeni sohbet başlatın', 'Sık iletişim kurulanlar',
      'Frequently contacted', 'WHATSAPP\'TAKİ KİŞİLER', 'CONTACTS ON WHATSAPP',
    ]);

    function isValidContact(name) {
      if (!name || name.length <= 1) return false;
      if (SKIP_NAMES.has(name)) return false;
      // Skip section headers (all caps, short)
      if (name === name.toUpperCase() && name.length < 30) return false;
      // Skip phone numbers (only digits, spaces, plus, dashes)
      if (/^[\d\s+\-()]+$/.test(name)) return false;
      return true;
    }

    function scrapeContacts() {
      // Contact list panel shows span[title] for each contact
      const spans = document.querySelectorAll('#app span[title]');
      for (const span of spans) {
        if (span.offsetHeight === 0) continue;
        if (span.closest('#main')) continue;
        if (span.closest('[contenteditable]')) continue;
        const name = (span.getAttribute('title') || '').trim();
        if (isValidContact(name)) {
          names.add(name);
        }
      }
    }

    scrapeContacts();

    // 3. Scroll to load all contacts (virtualized list)
    // Find the scrollable container within the new chat panel
    let scrollContainer = null;
    const panels = document.querySelectorAll('#app div[tabindex]');
    for (const panel of panels) {
      if (panel.scrollHeight > panel.clientHeight + 100 && panel.querySelector('span[title]')) {
        scrollContainer = panel;
        break;
      }
    }

    if (!scrollContainer) {
      // Fallback: find scrollable parent of first contact
      const firstContact = document.querySelector('#app span[title]:not(#main span[title])');
      if (firstContact) {
        let parent = firstContact.parentElement;
        while (parent && parent !== document.body) {
          if (parent.scrollHeight > parent.clientHeight + 100) {
            scrollContainer = parent;
            break;
          }
          parent = parent.parentElement;
        }
      }
    }

    if (scrollContainer) {
      console.log('[WPPhoto] Scrolling contact list...');
      let prevCount = 0;
      let noNewCount = 0;
      // Scroll until no new contacts appear (max 100 iterations)
      for (let i = 0; i < 100; i++) {
        scrollContainer.scrollTop += 800;
        await sleep(600);
        scrapeContacts();
        if (names.size === prevCount) {
          noNewCount++;
          if (noNewCount >= 5) break; // No new contacts after 5 scrolls
        } else {
          noNewCount = 0;
          prevCount = names.size;
        }
        if (i % 10 === 0) {
          console.log('[WPPhoto] Scroll iteration ' + i + ', contacts: ' + names.size);
        }
      }
    }

    console.log('[WPPhoto] Contact list: ' + names.size + ' contacts found');

    // 4. Close the new chat panel (press Escape or click back button)
    const backSelectors = [
      'span[data-icon="back"]',
      'span[data-icon="back-refreshed"]',
      'button[aria-label="Geri"]',
      'button[aria-label="Back"]',
    ];
    let closedPanel = false;
    for (const sel of backSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        (el.closest('button') || el).click();
        closedPanel = true;
        break;
      }
    }
    if (!closedPanel) {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true,
      }));
    }
    await sleep(500);

    return Array.from(names);
  }

  // =========================================================
  // Chat Label Detection — check header for WhatsApp labels
  // =========================================================
  function getChatLabels() {
    const mainEl = document.querySelector('#main');
    if (!mainEl) return [];

    const header = mainEl.querySelector('header');
    if (!header) return [];

    const labels = [];

    // WhatsApp labels appear as colored badges in the header
    // They typically have a colored background and text content
    // Look for spans/divs that contain label text near the contact name area
    const allElements = header.querySelectorAll('span, div');
    for (const el of allElements) {
      // Skip the contact name itself (typically the first large span)
      if (el.getAttribute('dir') === 'auto' && el.closest('[data-testid="conversation-info-header"]')) continue;
      if (el.closest('[contenteditable]')) continue;

      const text = el.textContent.trim();
      if (!text || text.length < 2 || text.length > 50) continue;

      // Labels have background color (not transparent)
      const style = window.getComputedStyle(el);
      const bg = style.backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' && bg !== 'rgb(32, 44, 51)' && bg !== 'rgb(17, 27, 33)') {
        // This element has a non-default background — likely a label badge
        labels.push(text);
      }
    }

    // Also try: look for label-specific data attributes or aria labels
    const labelBadges = header.querySelectorAll('[data-testid*="label"], [aria-label*="etiket"], [aria-label*="label"]');
    for (const badge of labelBadges) {
      const text = badge.textContent.trim();
      if (text && text.length >= 2 && !labels.includes(text)) {
        labels.push(text);
      }
    }

    console.log('[WPPhoto] Chat labels: ' + JSON.stringify(labels));
    return labels;
  }

  async function scanStoryContacts() {
    // 1. Find and click Status tab button
    let statusBtn = null;
    for (const sel of STATUS_SELECTORS.statusTabBtn) {
      const el = document.querySelector(sel);
      if (el) {
        statusBtn = el.closest('button') || el;
        break;
      }
    }
    if (!statusBtn) throw new Error('Durum sekmesi bulunamadi');

    // 2. Click Status tab and wait for panel to load
    console.log('[WPPhoto] Clicking Status tab...');
    statusBtn.click();
    await sleep(3500);

    // 3. Scrape story contacts from the status panel (lives OUTSIDE #side)
    const names = new Set();
    const SKIP_NAMES = new Set([
      'My Status', 'Durumum', 'My status', 'Durum güncellemem',
      'Status', 'Durum', 'Recent', 'Viewed', 'Recent updates', 'Viewed updates',
      'Son görülen', 'Görüldü', 'Son gorulen', 'Goruldu',
      'Güncellemeler', 'Updates', 'Kanallar', 'Channels',
      'Tümü', 'Okunmamış', 'Favoriler', 'Gruplar',
      'WhatsApp', 'Meta', 'Aratın veya yeni sohbet başlatın',
    ]);

    function isValidContactName(name) {
      if (!name || name.length <= 1) return false;
      if (SKIP_NAMES.has(name)) return false;
      if (name.length <= 2 && !/\d/.test(name)) return false;
      return true;
    }

    // Status panel is NOT inside #side — search outside #side and #main
    function scrapeStatusPanel() {
      document.querySelectorAll('span[title]').forEach(span => {
        if (span.closest('#side')) return;
        if (span.closest('#main')) return;
        if (span.offsetHeight === 0) return;
        const name = (span.getAttribute('title') || '').trim();
        if (isValidContactName(name)) {
          names.add(name);
        }
      });
    }

    scrapeStatusPanel();

    // 4. Scroll to load lazy contacts
    const statusSpan = document.querySelector('span[title]:not(#side span[title]):not(#main span[title])');
    if (statusSpan) {
      let scrollParent = statusSpan.parentElement;
      while (scrollParent && scrollParent !== document.body) {
        if (scrollParent.scrollHeight > scrollParent.clientHeight + 50) break;
        scrollParent = scrollParent.parentElement;
      }
      if (scrollParent && scrollParent !== document.body) {
        for (let i = 0; i < 5; i++) {
          scrollParent.scrollTop += 500;
          await sleep(600);
          scrapeStatusPanel();
        }
      }
    }

    console.log('[WPPhoto] Story contacts: ' + names.size + ' found');

    // 5. Navigate back to Chats tab
    let navigatedBack = false;
    for (const sel of STATUS_SELECTORS.backToChats) {
      const el = document.querySelector(sel);
      if (el) {
        (el.closest('button') || el).click();
        navigatedBack = true;
        break;
      }
    }
    if (!navigatedBack) {
      const chatIcon = document.querySelector('span[data-icon="chat-filled-refreshed"]');
      if (chatIcon) {
        (chatIcon.closest('button') || chatIcon).click();
      } else {
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true,
        }));
      }
    }
    await sleep(500);

    return Array.from(names);
  }

  // =========================================================
  // Trigger detection - cooldown check
  // =========================================================
  function shouldProcessTrigger(chatName, category) {
    const key = (chatName || 'unknown') + ':#' + category.toLowerCase();
    const lastTime = processedTriggers.get(key);
    if (lastTime && Date.now() - lastTime < TRIGGER_COOLDOWN_MS) return false;
    processedTriggers.set(key, Date.now());
    // Clean old entries
    if (processedTriggers.size > 100) {
      const cutoff = Date.now() - TRIGGER_COOLDOWN_MS;
      for (const [k, v] of processedTriggers) {
        if (v < cutoff) processedTriggers.delete(k);
      }
    }
    return true;
  }

  // =========================================================
  // v3: Scoped MutationObserver-based trigger watcher
  // =========================================================

  // Record existing messages with chat context to prevent dedup collisions
  function recordExistingMessages() {
    const currentChat = getCurrentChatName();
    // Record #main messages with chat context
    document.querySelectorAll('#main span[dir]').forEach(span => {
      const text = span.textContent.trim();
      if (text && text.length <= 200) {
        seenMessages.add('main:' + (currentChat || 'unknown') + ':' + text);
      }
    });
    // Record #side messages with sidebar chat context
    document.querySelectorAll('#side span[dir]').forEach(span => {
      const text = span.textContent.trim();
      if (text && text.length <= 200) {
        const sidebarChat = getChatNameFromSidebar(span);
        seenMessages.add('side:' + (sidebarChat || 'unknown') + ':' + text);
      }
    });
  }

  function scanForTriggers() {
    if (!autoModeEnabled) return;
    if (sidebarSwitching) return;

    // Detect chat switch - mark existing messages and skip this scan
    const currentChat = getCurrentChatName();
    if (currentChat !== lastChatName) {
      lastChatName = currentChat;
      chatSwitchTime = Date.now();
      document.querySelectorAll('#main span[dir]').forEach(span => {
        const text = span.textContent.trim();
        if (text) seenMessages.add('main:' + (currentChat || 'unknown') + ':' + text);
      });
      return;
    }

    // During grace period, keep marking #main messages as seen
    const inGracePeriod = Date.now() - chatSwitchTime < CHAT_SWITCH_GRACE_MS;
    if (inGracePeriod) {
      document.querySelectorAll('#main span[dir]').forEach(span => {
        const text = span.textContent.trim();
        if (text) seenMessages.add('main:' + (currentChat || 'unknown') + ':' + text);
      });
    }

    // Only scan within #main and #side containers
    const containers = [
      { el: document.querySelector('#main'), context: 'main' },
      { el: document.querySelector('#side'), context: 'side' },
    ];

    for (const { el: container, context } of containers) {
      if (!container) continue;

      const spans = container.querySelectorAll('span[dir]');
      for (const span of spans) {
        const text = span.textContent.trim();
        if (!text || text.length > 200) continue;

        const inMain = context === 'main';

        // Build dedup key with chat context to avoid collisions
        let messageKey;
        let chatContext;
        if (inMain) {
          chatContext = currentChat || 'unknown';
          messageKey = 'main:' + chatContext + ':' + text;
        } else {
          chatContext = getChatNameFromSidebar(span) || 'unknown';
          messageKey = 'side:' + chatContext + ':' + text;
        }

        if (seenMessages.has(messageKey)) continue;
        seenMessages.add(messageKey);

        const isIncoming = !span.closest('.message-out');

        // Skip #main messages during grace period
        if (inMain && inGracePeriod) continue;

        // --- #category trigger detection ---
        if (text.startsWith('#') && text.length >= 2 && text.length <= 50) {
          const category = text.substring(1).trim();
          if (!category) continue;

          if (inMain) {
            // Only incoming messages trigger in active chat
            if (!isIncoming) continue;
            if (!shouldProcessTrigger(currentChat, category)) continue;

            console.log('[WPPhoto] Active chat trigger: #' + category);
            chrome.runtime.sendMessage({ action: 'AUTO_SEND_TRIGGER', category: category });
            return;
          } else {
            // Sidebar trigger - use chatContext from sidebar
            if (chatContext === 'unknown') continue;
            if (!shouldProcessTrigger(chatContext, category)) continue;

            console.log('[WPPhoto] Sidebar trigger: #' + category + ' -> ' + chatContext);

            // Queue instead of immediate processing
            triggerQueue.push({ chatName: chatContext, category });
            processTriggerQueue();
            return;
          }
        }
      }
    }
  }

  // =========================================================
  // Serial trigger queue processing
  // =========================================================
  function processTriggerQueue() {
    if (processingTrigger) return;
    if (triggerQueue.length === 0) return;

    processingTrigger = true;
    const { chatName, category } = triggerQueue.shift();

    // Skip search if the chat is already open
    const currentChat = getCurrentChatName();
    const alreadyOpen = currentChat && chatName &&
      Math.min(currentChat.length, chatName.length) >= CHAT_NAME_MIN_MATCH &&
      (currentChat.toLowerCase().includes(chatName.toLowerCase()) ||
       chatName.toLowerCase().includes(currentChat.toLowerCase()));

    if (alreadyOpen) {
      console.log('[WPPhoto] Chat already open: ' + chatName + ', skipping search');
      chrome.runtime.sendMessage({ action: 'AUTO_SEND_TRIGGER', category: category });
      sleep(10000).finally(() => { processingTrigger = false; processTriggerQueue(); });
      return;
    }

    sidebarSwitching = true;

    switchToChatViaSearch(chatName)
      .then(switched => {
        // Mark all #main messages as seen after switch
        const newChat = getCurrentChatName();
        document.querySelectorAll('#main span[dir]').forEach(span => {
          const text = span.textContent.trim();
          if (text) seenMessages.add('main:' + (newChat || 'unknown') + ':' + text);
        });
        sidebarSwitching = false;
        chatSwitchTime = Date.now();

        if (switched) {
          chrome.runtime.sendMessage({ action: 'AUTO_SEND_TRIGGER', category: category });
        } else {
          console.warn('[WPPhoto] Could not open chat: ' + chatName);
        }

        // Wait before processing next item so photos can send
        return sleep(10000); // INTER_TRIGGER
      })
      .catch(err => {
        console.error('[WPPhoto] Trigger queue error: ' + err.message);
        sidebarSwitching = false;
      })
      .finally(() => {
        processingTrigger = false;
        processTriggerQueue();
      });
  }

  // =========================================================
  // v3: Scoped MutationObserver setup
  // =========================================================
  function debouncedScan() {
    if (scanDebounceTimer) clearTimeout(scanDebounceTimer);
    scanDebounceTimer = setTimeout(scanForTriggers, 150);
  }

  // Attach MutationObserver to a container, tracking the target element
  function attachToContainers() {
    const mainEl = document.querySelector('#main');
    const sideEl = document.querySelector('#side');

    if (mainEl && mainEl !== mainObserverTarget) {
      if (mainObserver) mainObserver.disconnect();
      mainObserver = new MutationObserver(debouncedScan);
      mainObserver.observe(mainEl, { childList: true, subtree: true, characterData: true });
      mainObserverTarget = mainEl;
    }

    if (sideEl && sideEl !== sideObserverTarget) {
      if (sideObserver) sideObserver.disconnect();
      sideObserver = new MutationObserver(debouncedScan);
      sideObserver.observe(sideEl, { childList: true, subtree: true, characterData: true });
      sideObserverTarget = sideEl;
    }
  }

  function initWatcher() {
    // Baseline: record all existing messages
    recordExistingMessages();
    lastChatName = getCurrentChatName();
    chatSwitchTime = Date.now();

    // Attach scoped observers to #main and #side
    attachToContainers();

    // Fallback polling: re-attach observers if containers were replaced + scan
    setInterval(() => {
      attachToContainers();
      scanForTriggers();
    }, 3000);

    // Periodically clear seenMessages to prevent unbounded growth
    // processedTriggers cooldown still prevents re-triggering
    setInterval(() => {
      seenMessages = new Set();
      recordExistingMessages();
    }, SEEN_MESSAGES_CLEAR_MS);

    console.log('[WPPhoto] Message watcher started (scoped MutationObserver)');
  }

  // =========================================================
  // Message listener
  // =========================================================
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'SEND_PHOTOS_BATCH') {
      handleSendPhotosBatch(message.data)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    if (message.action === 'SEND_TEXT') {
      sendTextMessage(message.data.text)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    if (message.action === 'GET_CHAT_NAME') {
      const name = getCurrentChatName();
      sendResponse({ chatName: name });
      return false;
    }

    if (message.action === 'SET_AUTO_MODE') {
      autoModeEnabled = message.enabled;
      console.log('[WPPhoto] Auto mode: ' + (autoModeEnabled ? 'ON' : 'OFF'));
      sendResponse({ success: true });
      return false;
    }

    if (message.action === 'SCAN_STORY_CONTACTS') {
      scanStoryContacts()
        .then(contacts => sendResponse({ success: true, contacts }))
        .catch(err => sendResponse({ success: false, error: err.message, contacts: [] }));
      return true;
    }

    if (message.action === 'SCAN_CONTACT_LIST') {
      scanContactList()
        .then(contacts => sendResponse({ success: true, contacts }))
        .catch(err => sendResponse({ success: false, error: err.message, contacts: [] }));
      return true;
    }

    if (message.action === 'CHECK_CHAT_LABELS') {
      const labels = getChatLabels();
      sendResponse({ labels });
      return false;
    }

    if (message.action === 'CHECK_CHAT_RECENCY') {
      const hasRecent = hasRecentMessages(message.days || 30);
      sendResponse(hasRecent);
      return false;
    }

    if (message.action === 'SWITCH_TO_CHAT') {
      switchToChatViaSearch(message.contactName)
        .then(switched => sendResponse({ success: switched }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    if (message.action === 'PING') {
      sendResponse({ success: true, ready: true });
      return false;
    }
  });

  // =========================================================
  // Init after page settles
  // =========================================================
  setTimeout(initWatcher, 2000);

  console.log('[WPPhoto] Content script v5.0.0 loaded');
}
