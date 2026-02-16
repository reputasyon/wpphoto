// WPPhoto v2 - Content Script (WhatsApp Web)
// Injected into web.whatsapp.com - handles photo sending, trigger detection, chat navigation

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

  const SELECTORS = {
    chatPane: ['#main', '[data-testid="conversation-panel-wrapper"]'],
    composeInput: [
      '[data-testid="conversation-compose-box-input"]',
      'div[contenteditable="true"][data-tab="10"]',
      'footer div[contenteditable="true"]',
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
  let seenMessages = new Set();         // "context:text" dedup
  const triggerQueue = [];              // { chatName, category }
  let processingTrigger = false;

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
    if (!chatPane) throw new Error('Open a chat and try again');

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

    // If no caption input found, paste likely failed - media preview never opened
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
      throw new Error('Photos could not be sent - send button did not work');
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
  // Text message sending
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

    pressEnter(composeBox);
    console.log('[WPPhoto] Text message sent: ' + text);
    await sleep(500);
  }

  // =========================================================
  // Chat navigation via search
  // =========================================================
  async function switchToChatViaSearch(contactName) {
    const prevChat = getCurrentChatName();

    // 1. Click search icon
    const searchIcon = document.querySelector('[data-testid="chat-list-search"]')
      || document.querySelector('span[data-icon="search"]')?.closest('button')
      || document.querySelector('#side button');
    if (!searchIcon) {
      console.warn('[WPPhoto] Search icon not found');
      return false;
    }
    searchIcon.click();
    await sleep(600); // SEARCH_ICON

    // 2. Find search box and type contact name
    const searchBox = document.querySelector('[data-testid="chat-list-search"] input')
      || document.querySelector('#side [contenteditable="true"]')
      || document.querySelector('[data-testid="search-input"]');
    if (!searchBox) {
      console.warn('[WPPhoto] Search box not found');
      return false;
    }
    searchBox.focus();
    await sleep(300); // SEARCH_TYPE
    document.execCommand('selectAll');
    document.execCommand('insertText', false, contactName);
    await sleep(1500); // SEARCH_RESULTS

    // 3. Press Enter to open first result
    pressEnter(searchBox);

    // 4. Wait for chat to switch (max 5s)
    for (let i = 0; i < 10; i++) { // CHAT_SWITCH_MAX
      await sleep(500); // CHAT_SWITCH_CHECK
      const nowChat = getCurrentChatName();
      if (nowChat && nowChat !== prevChat) {
        console.log('[WPPhoto] Chat switched: ' + prevChat + ' -> ' + nowChat);

        // P1#8: Verify correct chat opened
        const intended = contactName.toLowerCase();
        const actual = nowChat.toLowerCase();
        if (actual.includes(intended) || intended.includes(actual)) {
          return true;
        }
        console.warn('[WPPhoto] Chat mismatch: intended "' + contactName + '" but got "' + nowChat + '"');
        return false;
      }
    }

    console.warn('[WPPhoto] Chat did not switch: ' + contactName);
    return false;
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
  // MutationObserver-based trigger watcher
  // =========================================================
  function recordExistingMessages() {
    document.querySelectorAll('span[dir]').forEach(span => {
      const text = span.textContent.trim();
      if (text && text.length <= 200) {
        const context = span.closest('#main') ? 'main' : 'side';
        seenMessages.add(context + ':' + text);
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
        if (text) seenMessages.add('main:' + text);
      });
      return;
    }

    // During grace period, keep marking #main messages as seen
    const inGracePeriod = Date.now() - chatSwitchTime < CHAT_SWITCH_GRACE_MS;
    if (inGracePeriod) {
      document.querySelectorAll('#main span[dir]').forEach(span => {
        const text = span.textContent.trim();
        if (text) seenMessages.add('main:' + text);
      });
    }

    const allSpans = document.querySelectorAll('span[dir]');

    for (const span of allSpans) {
      const text = span.textContent.trim();
      if (!text || text.length > 200) continue;

      const inMain = !!span.closest('#main');
      const context = inMain ? 'main' : 'side';
      const key = context + ':' + text;

      if (seenMessages.has(key)) continue;
      seenMessages.add(key);

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
          // Sidebar trigger - find contact name
          const chatName = getChatNameFromSidebar(span);
          if (!chatName) continue;
          if (!shouldProcessTrigger(chatName, category)) continue;

          console.log('[WPPhoto] Sidebar trigger: #' + category + ' -> ' + chatName);

          // P1#6: Queue instead of immediate processing
          triggerQueue.push({ chatName, category });
          processTriggerQueue();
          return;
        }
      }
    }
  }

  // =========================================================
  // Serial trigger queue processing (P1#6)
  // =========================================================
  function processTriggerQueue() {
    if (processingTrigger) return;
    if (triggerQueue.length === 0) return;

    processingTrigger = true;
    const { chatName, category } = triggerQueue.shift();

    // Skip search if the chat is already open
    const currentChat = getCurrentChatName();
    const alreadyOpen = currentChat &&
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
        document.querySelectorAll('#main span[dir]').forEach(span => {
          const text = span.textContent.trim();
          if (text) seenMessages.add('main:' + text);
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
  // MutationObserver setup (P1#5)
  // =========================================================
  let scanDebounceTimer = null;

  function initWatcher() {
    // Baseline: record all existing messages
    recordExistingMessages();
    lastChatName = getCurrentChatName();
    chatSwitchTime = Date.now();

    // MutationObserver with debounced scan
    const observer = new MutationObserver(() => {
      if (scanDebounceTimer) clearTimeout(scanDebounceTimer);
      scanDebounceTimer = setTimeout(scanForTriggers, 150);
    });

    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    // Fallback polling: MutationObserver may miss some sidebar text updates
    setInterval(scanForTriggers, 3000);

    // Periodically clear seenMessages to prevent unbounded growth
    // processedTriggers cooldown still prevents re-triggering
    setInterval(() => {
      seenMessages = new Set();
      recordExistingMessages();
    }, SEEN_MESSAGES_CLEAR_MS);

    console.log('[WPPhoto] Message watcher started (MutationObserver, #category active)');
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

    if (message.action === 'PING') {
      sendResponse({ success: true, ready: true });
      return false;
    }
  });

  // =========================================================
  // Init after page settles
  // =========================================================
  setTimeout(initWatcher, 2000);

  console.log('[WPPhoto] Content script v2.0.0 loaded');
}
