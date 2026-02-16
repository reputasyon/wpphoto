// WPPhoto - Content Script (WhatsApp Web)
// v1.9.0 - Caption fotoğraf altına yapışık + debugger Enter

const SELECTORS = {
  chatPane: [
    '#main',
    '[data-testid="conversation-panel-wrapper"]',
  ],
  composeInput: [
    '[data-testid="conversation-compose-box-input"]',
    'div[contenteditable="true"][data-tab="10"]',
    'footer div[contenteditable="true"]',
  ],
};

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
  // Bilinen compose box'lari tanimla (bunlari HARIC tutacagiz)
  const composeBox = querySelector(SELECTORS.composeInput);

  // 1. Bilinen media caption selector'lari
  const selectors = [
    '[data-testid="media-caption-input"] [contenteditable="true"]',
    '[data-testid="media-caption-input-container"] [contenteditable="true"]',
    '[data-testid="media-editor"] [contenteditable="true"]',
    '[data-testid="media-editor-container"] [contenteditable="true"]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      console.log('[WPPhoto] Caption input bulundu (selector): ' + sel);
      return el;
    }
  }

  // 2. Fallback: compose box OLMAYAN gorunur contenteditable
  const allEditable = document.querySelectorAll('[contenteditable="true"]');
  console.log('[WPPhoto] Toplam contenteditable sayisi: ' + allEditable.length);

  for (const el of allEditable) {
    // Ana compose box'i atla
    if (el === composeBox) continue;
    if (el.getAttribute('data-tab') === '10') continue;
    // Sidebar arama kutusunu atla
    if (el.closest('#side')) continue;
    // Gorunur olmali
    if (el.offsetHeight === 0) continue;

    // placeholder text varsa buyuk ihtimal caption alani
    const placeholder = el.getAttribute('data-placeholder')
      || el.getAttribute('title')
      || el.closest('[data-placeholder]')?.getAttribute('data-placeholder')
      || '';
    console.log('[WPPhoto] Aday contenteditable: height=' + el.offsetHeight + ' placeholder="' + placeholder + '"');
    return el;
  }

  console.warn('[WPPhoto] Hicbir caption alani bulunamadi');
  return null;
}

function pressEnter(target) {
  // Oncelik: verilen target > compose box > activeElement > body
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

// =========================================================
// Fotograflari gonder + ardından klasor ismini mesaj at
// =========================================================
async function handleSendPhotosBatch({ files, caption }) {
  const chatPane = querySelector(SELECTORS.chatPane);
  if (!chatPane) throw new Error('Bir sohbet acin ve tekrar deneyin');

  const fileObjects = files.map(f => base64ToFile(f.base64, f.fileName, f.mimeType));

  const composeBox = querySelector(SELECTORS.composeInput);
  if (composeBox) composeBox.focus();
  await sleep(300);

  const dt = new DataTransfer();
  for (const file of fileObjects) {
    dt.items.add(file);
  }

  (composeBox || document).dispatchEvent(new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData: dt,
  }));

  console.log('[WPPhoto] Paste dispatched, ' + fileObjects.length + ' dosya');

  await sleep(3000);

  // Caption alanini bul (media preview aciksa vardir)
  let captionInput = null;
  for (let i = 0; i < 5; i++) {
    captionInput = findCaptionInput();
    if (captionInput) break;
    await sleep(500);
  }
  console.log('[WPPhoto] Caption input: ' + (captionInput ? 'bulundu' : 'yok'));

  // Caption input varsa focus ver (Enter icin gerekli)
  if (captionInput) {
    captionInput.focus();
    await sleep(300);
  }

  // Gonderim: 3 yontem sirali dene
  let sent = false;

  // 1. MAIN world'den gonder butonuna tikla
  console.log('[WPPhoto] Gonder butonu aranıyor (MAIN world)...');
  const sendResult = await new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'CLICK_SEND_BUTTON' }, response => {
      resolve(response);
    });
  });
  if (sendResult?.success) {
    console.log('[WPPhoto] Gonder butonu tiklandi: ' + sendResult.selector);
    sent = true;
  }

  // 2. MAIN world basarisizsa: debugger Enter (focus zaten caption input'ta)
  if (!sent) {
    console.log('[WPPhoto] Gonder butonu bulunamadi, debugger Enter deneniyor...');
    // Focus'u tekrar caption input'a ver (MAIN world script kaybettirmis olabilir)
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
      console.log('[WPPhoto] Debugger Enter gonderildi');
      sent = true;
    }
  }

  // 3. Son fallback: normal Enter
  if (!sent) {
    console.log('[WPPhoto] Debugger basarisiz, normal Enter deneniyor...');
    if (captionInput) captionInput.focus();
    await sleep(300);
    pressEnter(captionInput);
  }

  await sleep(3000);

  // Media preview hala acik mi kontrol et
  const stillOpen = findCaptionInput();
  if (stillOpen) {
    console.warn('[WPPhoto] Media preview hala acik - fotograflar gonderilemedi');
    // Escape ile preview'i kapat
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    throw new Error('Fotograflar gonderilemedi - gonder butonu calismadi');
  }

  console.log('[WPPhoto] Fotograflar gonderildi');

  // Fotograflar gonderildikten sonra klasor ismini ayri mesaj olarak gonder
  if (caption) {
    await sleep(1500);
    console.log('[WPPhoto] Klasor ismi gonderiliyor: ' + caption);
    await sendTextMessage(caption);
  }
}

// =========================================================
// Metin mesaji gonder
// =========================================================
async function sendTextMessage(text) {
  const composeBox = querySelector(SELECTORS.composeInput);
  if (!composeBox) {
    console.warn('[WPPhoto] Compose box bulunamadi');
    return;
  }

  composeBox.focus();
  await sleep(500);

  document.execCommand('insertText', false, text);
  await sleep(500);

  pressEnter(composeBox);
  console.log('[WPPhoto] Mesaj gonderildi: ' + text);
  await sleep(500);
}

// =========================================================
// Tek foto handler
// =========================================================
async function handleSendPhoto({ base64, fileName, mimeType, caption }) {
  await handleSendPhotosBatch({
    files: [{ base64, fileName, mimeType }],
    caption,
  });
}

// =========================================================
// Message Listener
// =========================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'SEND_PHOTO') {
    handleSendPhoto(message.data)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'SEND_PHOTOS_BATCH') {
    handleSendPhotosBatch(message.data)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'SEND_TEXT') {
    sendTextMessage(message.data.text)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'GET_CHAT_NAME') {
    const name = getCurrentChatName();
    sendResponse({ chatName: name });
    return false;
  }

  if (message.action === 'SET_AUTO_MODE') {
    autoModeEnabled = message.enabled;
    console.log('[WPPhoto] Otomatik mod: ' + (autoModeEnabled ? 'ACIK' : 'KAPALI'));
    sendResponse({ success: true });
    return false;
  }

  if (message.action === 'PING') {
    sendResponse({ success: true, ready: true });
    return false;
  }
});

// =========================================================
// Mesaj izleyici: #kategori algilama
// WeakSet ile dedup, sidebar + aktif chat
// =========================================================
const seenSpans = new WeakSet();
let sidebarSwitching = false;
let autoModeEnabled = false;

// Ayni kategori tetikleyicisini tekrar gondermemek icin cooldown
const processedTriggers = new Map(); // "chatName:#category" -> timestamp
const TRIGGER_COOLDOWN_MS = 5 * 60 * 1000; // 5 dakika


function shouldProcessTrigger(chatName, category) {
  const key = (chatName || 'unknown') + ':#' + category.toLowerCase();
  const lastTime = processedTriggers.get(key);
  if (lastTime && Date.now() - lastTime < TRIGGER_COOLDOWN_MS) return false;
  processedTriggers.set(key, Date.now());
  // Eski kayitlari temizle
  if (processedTriggers.size > 100) {
    const cutoff = Date.now() - TRIGGER_COOLDOWN_MS;
    for (const [k, v] of processedTriggers) {
      if (v < cutoff) processedTriggers.delete(k);
    }
  }
  return true;
}

// Kayitli durumu yukle
chrome.storage.local.get('autoMode', result => {
  autoModeEnabled = result.autoMode || false;
  console.log('[WPPhoto] Otomatik mod baslangic: ' + (autoModeEnabled ? 'ACIK' : 'KAPALI'));
});


function getCurrentChatName() {
  const header = document.querySelector('#main header');
  if (!header) return null;
  const nameSpan = header.querySelector('span[dir="auto"]');
  return nameSpan ? nameSpan.textContent.trim() : null;
}

let lastChatName = null;
let chatSwitchTime = 0;
const CHAT_SWITCH_GRACE_MS = 9000; // Chat acildiktan sonra 9sn bekle (3 tarama dongusu)

function initWatcher() {
  // Sayfadaki mevcut tum span'lari "goruldu" isaretle
  document.querySelectorAll('span[dir]').forEach(s => seenSpans.add(s));
  lastChatName = getCurrentChatName();
  chatSwitchTime = Date.now();

  // 3 saniyede bir tara
  setInterval(scanForTriggers, 3000);
  console.log('[WPPhoto] Mesaj izleyici baslatildi (#kategori aktif)');
}

function scanForTriggers() {
  if (!autoModeEnabled) return;
  if (sidebarSwitching) return;

  // Chat degisti mi? Degistiyse mevcut mesajlari isaretle, bu turda islem yapma
  const currentChat = getCurrentChatName();
  if (currentChat !== lastChatName) {
    lastChatName = currentChat;
    chatSwitchTime = Date.now();
    document.querySelectorAll('#main span[dir]').forEach(s => seenSpans.add(s));
    return;
  }

  // Chat yeni acildiysa, #main icindeki eski mesajlari isaretle
  // Ama sidebar taramasina devam et
  const inGracePeriod = Date.now() - chatSwitchTime < CHAT_SWITCH_GRACE_MS;
  if (inGracePeriod) {
    document.querySelectorAll('#main span[dir]').forEach(s => seenSpans.add(s));
  }

  const allSpans = document.querySelectorAll('span[dir]');

  for (const span of allSpans) {
    if (seenSpans.has(span)) continue;
    seenSpans.add(span);

    const text = span.textContent.trim();
    if (!text || text.length > 200) continue;

    const isIncoming = !span.closest('.message-out');
    const inMain = span.closest('#main');

    // Grace period: #main icindeki mesajlari atla (eski mesaj tetiklemesini onle)
    if (inMain && inGracePeriod) continue;

    // --- #kategori tetikleyici ---
    if (text.startsWith('#') && text.length >= 2 && text.length <= 50) {
      const category = text.substring(1).trim();
      if (!category) continue;

      if (inMain) {
        if (!isIncoming) continue;

        // Ayni chat + kategori icin 5dk cooldown
        if (!shouldProcessTrigger(currentChat, category)) continue;

        console.log('[WPPhoto] Aktif chat trigger: #' + category);

        chrome.runtime.sendMessage({ action: 'AUTO_SEND_TRIGGER', category: category });
        return;
      } else {
        // Sidebar'dan kisi ismini bul
        const chatName = getChatNameFromSidebar(span);
        if (!chatName) continue;

        // Ayni chat + kategori icin 5dk cooldown
        if (!shouldProcessTrigger(chatName, category)) continue;

        console.log('[WPPhoto] Sidebar trigger: #' + category + ' -> ' + chatName);
        sidebarSwitching = true;

        // Arama ile sohbete gec
        switchToChatViaSearch(chatName).then(switched => {
          document.querySelectorAll('#main span[dir]').forEach(s => seenSpans.add(s));
          sidebarSwitching = false;
          chatSwitchTime = Date.now();

          if (switched) {
            chrome.runtime.sendMessage({ action: 'AUTO_SEND_TRIGGER', category: category });
          } else {
            console.warn('[WPPhoto] Sohbet acilamadi: ' + chatName);
          }
        });

        return;
      }
    }

  }
}

// Sidebar'dan kisi ismini bul
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

// WhatsApp arama kutusu ile sohbete gec
async function switchToChatViaSearch(contactName) {
  const prevChat = getCurrentChatName();

  // 1. Arama ikonuna tikla
  const searchIcon = document.querySelector('[data-testid="chat-list-search"]')
    || document.querySelector('span[data-icon="search"]')?.closest('button')
    || document.querySelector('#side button');
  if (!searchIcon) {
    console.warn('[WPPhoto] Arama ikonu bulunamadi');
    return false;
  }
  searchIcon.click();
  await sleep(600);

  // 2. Arama kutusunu bul ve yaz
  const searchBox = document.querySelector('[data-testid="chat-list-search"] input')
    || document.querySelector('#side [contenteditable="true"]')
    || document.querySelector('[data-testid="search-input"]');
  if (!searchBox) {
    console.warn('[WPPhoto] Arama kutusu bulunamadi');
    return false;
  }
  searchBox.focus();
  await sleep(300);
  // Onceki metni temizle
  document.execCommand('selectAll');
  document.execCommand('insertText', false, contactName);
  await sleep(1500);

  // 3. Enter ile ilk sonucu ac
  pressEnter(searchBox);

  // 4. Sohbet degisene kadar bekle (max 5sn)
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    const nowChat = getCurrentChatName();
    if (nowChat && nowChat !== prevChat) {
      console.log('[WPPhoto] Sohbet degisti: ' + prevChat + ' -> ' + nowChat);
      return true;
    }
  }

  console.warn('[WPPhoto] Sohbet degismedi: ' + contactName);
  return false;
}

// 2sn sonra baslat (sayfa yuklensin)
setTimeout(initWatcher, 2000);

console.log('[WPPhoto] Content script v1.9.0 yuklendi');
