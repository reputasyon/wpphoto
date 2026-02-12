// WPPhoto - Side Panel Application
// Klasor okuma, kategori butonlari, WhatsApp'a tek tikla gonderme

// --- IndexedDB helpers ---
const DB_NAME = 'wpphoto-store';
const STORE_NAME = 'keyval';
const DIR_HANDLE_KEY = 'directory-handle';

function _getDB() {
  if (!_getDB._p) {
    _getDB._p = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return _getDB._p;
}

async function idbGet(key) {
  const db = await _getDB();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await _getDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  store.put(value, key);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- Constants ---
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

// --- State ---
let categories = new Map(); // name -> [{name, handle, categoryName}]
let dirHandle = null;
let isSending = false;

// --- DOM References ---
const btnSelectFolder = document.getElementById('btn-select-folder');
const btnRefresh = document.getElementById('btn-refresh');
const btnChangeFolder = document.getElementById('btn-change-folder');
const folderNameEl = document.getElementById('folder-name');
const categoryListEl = document.getElementById('category-list');
const emptyState = document.getElementById('empty-state');
const loadingEl = document.getElementById('loading');
const toastContainer = document.getElementById('toast-container');
const autoModeBar = document.getElementById('auto-mode-bar');
const btnAutoToggle = document.getElementById('btn-auto-toggle');
const sendAllBar = document.getElementById('send-all-bar');
const btnSendAll = document.getElementById('btn-send-all');
const sendAllLabel = document.getElementById('send-all-label');
const dailyStatsEl = document.getElementById('daily-stats');
const statsCountEl = document.getElementById('stats-count');

// --- Auto mode state ---
let autoModeEnabled = false;

// --- Daily stats ---
function getTodayKey() {
  const d = new Date();
  return 'stats-' + d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

async function loadDailyStats() {
  const key = getTodayKey();
  const result = await chrome.storage.local.get(key);
  const names = result[key] || [];
  statsCountEl.textContent = names.length + ' kisi';
}

async function trackShareToContact() {
  // Aktif sohbetin ismini content script'ten al
  let chatName = null;
  try {
    const tab = await getWhatsAppTab();
    chatName = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { action: 'GET_CHAT_NAME' }, (response) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(response?.chatName || null);
      });
    });
  } catch (e) {}

  if (!chatName) return;

  const key = getTodayKey();
  const result = await chrome.storage.local.get(key);
  const names = result[key] || [];
  if (!names.includes(chatName)) {
    names.push(chatName);
    await chrome.storage.local.set({ [key]: names });
  }
  statsCountEl.textContent = names.length + ' kisi';
}
let sendAllCancelled = false;

// --- Event Listeners ---
btnSelectFolder.addEventListener('click', selectFolder);
btnRefresh.addEventListener('click', refreshFolder);
btnChangeFolder.addEventListener('click', selectFolder);
btnAutoToggle.addEventListener('click', toggleAutoMode);
btnSendAll.addEventListener('click', handleSendAllClick);

async function toggleAutoMode() {
  autoModeEnabled = !autoModeEnabled;
  autoModeBar.classList.toggle('active', autoModeEnabled);
  await chrome.storage.local.set({ autoMode: autoModeEnabled });

  // Content script'e bildir
  try {
    const tab = await getWhatsAppTab();
    await ensureContentScript(tab);
    chrome.tabs.sendMessage(tab.id, { action: 'SET_AUTO_MODE', enabled: autoModeEnabled });
  } catch (e) {
    // WhatsApp acik degil, sorun degil
  }

  showToast(autoModeEnabled ? 'Otomatik yanit ACIK' : 'Otomatik yanit KAPALI', autoModeEnabled ? 'success' : 'info');
}

async function loadAutoMode() {
  const result = await chrome.storage.local.get('autoMode');
  autoModeEnabled = result.autoMode || false;
  autoModeBar.classList.toggle('active', autoModeEnabled);

  // Content script'e de bildir
  try {
    const tab = await getWhatsAppTab();
    chrome.tabs.sendMessage(tab.id, { action: 'SET_AUTO_MODE', enabled: autoModeEnabled });
  } catch (e) {}
}

// --- Auto-trigger: #kategori + selamlama dinle ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!autoModeEnabled) return; // Kapaliysa yok say

  if (message.action === 'AUTO_SEND_TRIGGER') {
    handleAutoSend(message.category);
  }
  if (message.action === 'GREETING_TRIGGER') {
    handleGreeting(message.lang || 'tr');
  }
});

async function handleAutoSend(triggerCategory) {
  if (isSending) return;
  if (categories.size === 0) return;

  // Kategoriyi bul (case-insensitive)
  let matchedName = null;
  for (const name of categories.keys()) {
    if (name.toLowerCase() === triggerCategory.toLowerCase()) {
      matchedName = name;
      break;
    }
  }

  if (!matchedName) {
    console.log('[WPPhoto] Kategori bulunamadi: ' + triggerCategory);
    return;
  }

  // Butonu bul (gorsel feedback icin)
  const btns = categoryListEl.querySelectorAll('.category-btn');
  let btnElement = null;
  for (const btn of btns) {
    const nameEl = btn.querySelector('.cat-name');
    if (nameEl && nameEl.textContent === matchedName) {
      btnElement = btn;
      break;
    }
  }

  if (btnElement) {
    showToast('#' + triggerCategory + ' algilandi, gonderiliyor...', 'info');
    await sendCategory(matchedName, btnElement);
  }
}

const MENU_TEMPLATES = {
  tr: {
    greeting: 'Merhaba! Urun kategorilerimiz:',
    photoLabel: 'foto',
    footer: 'Kategori adini # ile yazin, fotograflari gonderelim.',
  },
  en: {
    greeting: 'Hello! Our product categories:',
    photoLabel: 'photos',
    footer: 'Type the category name with # to receive photos.',
  },
  ar: {
    greeting: 'أهلاً! فئات منتجاتنا:',
    photoLabel: 'صور',
    footer: 'اكتب اسم الفئة مع # لاستلام الصور.',
  },
};

async function handleGreeting(lang) {
  if (isSending) return;
  if (categories.size === 0) return;

  const t = MENU_TEMPLATES[lang] || MENU_TEMPLATES.tr;

  const sorted = Array.from(categories.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  let menuText = t.greeting + '\n\n';
  for (const [name, files] of sorted) {
    menuText += '• #' + name + ' (' + files.length + ' ' + t.photoLabel + ')\n';
  }
  menuText += '\n' + t.footer;

  try {
    const tab = await getWhatsAppTab();
    await ensureContentScript(tab);

    await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tab.id, {
        action: 'SEND_TEXT',
        data: { text: menuText },
      }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });

    showToast('Menu gonderildi', 'success');
  } catch (err) {
    console.warn('[WPPhoto] Menu gonderilemedi:', err.message);
  }
}

// --- Init ---
init();

async function init() {
  try {
    const savedHandle = await idbGet(DIR_HANDLE_KEY);
    if (savedHandle) {
      const permission = await savedHandle.queryPermission({ mode: 'read' });
      if (permission === 'granted') {
        dirHandle = savedHandle;
        await loadCategories();
        return;
      }
      // Izin iste (kullanici gesture gerektirir)
      try {
        const requested = await savedHandle.requestPermission({ mode: 'read' });
        if (requested === 'granted') {
          dirHandle = savedHandle;
          await loadCategories();
          return;
        }
      } catch (e) {
        // Izin istenemedi, kullanici tekrar secmeli
      }
    }
  } catch (e) {
    console.warn('[WPPhoto] Kayitli klasor yuklenemedi:', e);
  }
  showEmptyState();
}

// --- Folder Selection ---
async function selectFolder() {
  try {
    if (window.showDirectoryPicker) {
      dirHandle = await window.showDirectoryPicker({ mode: 'read' });
      await idbSet(DIR_HANDLE_KEY, dirHandle);
      await loadCategories();
    } else {
      showToast('Bu tarayici klasor secmeyi desteklemiyor', 'error');
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      showToast('Klasor secilemedi: ' + err.message, 'error');
    }
  }
}

async function refreshFolder() {
  if (!dirHandle) return;
  await loadCategories();
  showToast('Yenilendi', 'success');
}

// --- Load Categories (sadece klasor isimleri ve dosya sayilari) ---
async function loadCategories() {
  if (!dirHandle) return;

  showLoading();
  categories = new Map();
  await loadCategoryOrder();

  try {
    for await (const entry of dirHandle.values()) {
      if (entry.kind === 'directory') {
        const files = [];
        try {
          for await (const fileEntry of entry.values()) {
            if (fileEntry.kind === 'file' && isImage(fileEntry.name)) {
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
          categories.set(entry.name, files);
        }
      } else if (entry.kind === 'file' && isImage(entry.name)) {
        if (!categories.has('Genel')) categories.set('Genel', []);
        categories.get('Genel').push({
          name: entry.name,
          handle: entry,
          categoryName: 'Genel',
        });
      }
    }

    if (categories.has('Genel')) {
      categories.get('Genel').sort((a, b) => a.name.localeCompare(b.name));
    }

    // UI guncelle
    folderNameEl.textContent = dirHandle.name;
    folderNameEl.classList.remove('hidden');
    btnRefresh.classList.remove('hidden');
    btnChangeFolder.classList.remove('hidden');

    if (categories.size === 0) {
      showEmptyState();
      showToast('Klasorde fotograf bulunamadi', 'info');
      return;
    }

    hideLoading();
    emptyState.classList.add('hidden');
    autoModeBar.classList.remove('hidden');
    sendAllBar.classList.remove('hidden');
    dailyStatsEl.classList.remove('hidden');
    renderCategoryButtons();
    loadAutoMode();
    loadDailyStats();
  } catch (err) {
    hideLoading();
    showToast('Yuklenemedi: ' + err.message, 'error');
    showEmptyState();
  }
}

// --- Selection state ---
const selectedCategories = new Set();
let categoryOrder = []; // Kaydedilmis siralama

function updateSendAllButton() {
  if (selectedCategories.size > 0) {
    sendAllLabel.textContent = 'Secilenleri Gonder (' + selectedCategories.size + ')';
  } else {
    sendAllLabel.textContent = 'Tumunu Gonder';
  }
}

function toggleCategorySelection(name, btn) {
  if (selectedCategories.has(name)) {
    selectedCategories.delete(name);
    btn.classList.remove('selected');
  } else {
    selectedCategories.add(name);
    btn.classList.add('selected');
  }
  updateSendAllButton();
}

// --- Siralama ---
async function loadCategoryOrder() {
  const result = await chrome.storage.local.get('categoryOrder');
  categoryOrder = result.categoryOrder || [];
}

async function saveCategoryOrder() {
  const btns = categoryListEl.querySelectorAll('.category-btn');
  categoryOrder = Array.from(btns).map(b => b.querySelector('.cat-name').textContent);
  await chrome.storage.local.set({ categoryOrder });
}

function getSortedCategories() {
  const entries = Array.from(categories.entries());
  if (categoryOrder.length > 0) {
    // Kaydedilmis siraya gore sirala, yeniler sona
    entries.sort((a, b) => {
      const idxA = categoryOrder.indexOf(a[0]);
      const idxB = categoryOrder.indexOf(b[0]);
      if (idxA === -1 && idxB === -1) return a[0].localeCompare(b[0]);
      if (idxA === -1) return 1;
      if (idxB === -1) return -1;
      return idxA - idxB;
    });
  } else {
    entries.sort((a, b) => a[0].localeCompare(b[0]));
  }
  return entries;
}

function moveCategoryUp(btn) {
  const prev = btn.previousElementSibling;
  if (prev) {
    categoryListEl.insertBefore(btn, prev);
    saveCategoryOrder();
  }
}

function moveCategoryDown(btn) {
  const next = btn.nextElementSibling;
  if (next) {
    categoryListEl.insertBefore(next, btn);
    saveCategoryOrder();
  }
}

// --- Render Category Buttons ---
function renderCategoryButtons() {
  categoryListEl.innerHTML = '';
  selectedCategories.clear();

  const sorted = getSortedCategories();

  for (const [name, files] of sorted) {
    const btn = document.createElement('button');
    btn.className = 'category-btn';
    btn.innerHTML =
      '<div class="cat-check">' +
        '<span class="check-box"></span>' +
      '</div>' +
      '<div class="cat-left">' +
        '<div class="cat-icon">' +
          '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>' +
          '</svg>' +
        '</div>' +
        '<span class="cat-name">' + name + '</span>' +
      '</div>' +
      '<div class="cat-right">' +
        '<span class="cat-count">' + files.length + ' foto</span>' +
        '<div class="cat-arrows">' +
          '<span class="arrow-btn arrow-up" title="Yukari">&#9650;</span>' +
          '<span class="arrow-btn arrow-down" title="Asagi">&#9660;</span>' +
        '</div>' +
      '</div>';

    // Checkbox tikla = secim
    btn.querySelector('.cat-check').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCategorySelection(name, btn);
    });

    // Ok butonlari
    btn.querySelector('.arrow-up').addEventListener('click', (e) => {
      e.stopPropagation();
      moveCategoryUp(btn);
    });
    btn.querySelector('.arrow-down').addEventListener('click', (e) => {
      e.stopPropagation();
      moveCategoryDown(btn);
    });

    // Buton tikla = tekli gonder
    btn.addEventListener('click', () => sendCategory(name, btn));
    categoryListEl.appendChild(btn);
  }

  updateSendAllButton();
}

// --- Send All Photos in a Category ---
const BATCH_MAX_BYTES = 50 * 1024 * 1024; // 50MB limit (Chrome 64MB siniri icin guvenli)

// base64 dosyalarini boyuta gore gruplara bol
function splitIntoBatches(files) {
  const batches = [];
  let current = [];
  let currentSize = 0;

  for (const f of files) {
    const size = f.base64.length; // base64 string uzunlugu ~ byte boyutu
    // Tek dosya bile limite yakinsa kendi basina grup olsun
    if (current.length > 0 && currentSize + size > BATCH_MAX_BYTES) {
      batches.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(f);
    currentSize += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function sendCategory(categoryName, btnElement) {
  if (isSending) return;
  isSending = true;

  const files = categories.get(categoryName);
  if (!files || files.length === 0) {
    showToast('Bu kategoride fotograf yok', 'info');
    isSending = false;
    return;
  }

  // Buton durumunu guncelle
  btnElement.classList.add('sending');
  const countEl = btnElement.querySelector('.cat-count');
  const originalCount = countEl.textContent;
  countEl.innerHTML = '<div class="cat-spinner"></div>';

  try {
    const tab = await getWhatsAppTab();
    await ensureContentScript(tab);

    // Tum dosyalari base64'e cevir (bulunamayanları atla)
    const allFiles = [];
    let skipped = 0;
    for (const fileInfo of files) {
      try {
        const data = await getFileData(fileInfo);
        allFiles.push(data);
      } catch (e) {
        skipped++;
        console.warn('[WPPhoto] Dosya okunamadi, atlaniyor: ' + fileInfo.name, e.message);
      }
    }

    if (allFiles.length === 0) {
      showToast('Hicbir dosya okunamadi (klasoru yenileyin)', 'error');
      return;
    }

    if (skipped > 0) {
      showToast(skipped + ' dosya atlandi (bulunamadi)', 'info');
      await new Promise(r => setTimeout(r, 1000));
    }

    // Boyuta gore gruplara bol
    const batches = splitIntoBatches(allFiles);

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      const isLastBatch = b === batches.length - 1;

      if (batches.length > 1) {
        showToast('Grup ' + (b + 1) + '/' + batches.length + ' gonderiliyor (' + batch.length + ' foto)...', 'info');
      } else {
        showToast(batch.length + ' fotograf gonderiliyor...', 'info');
      }

      // Sadece son grupta caption gonder
      await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tab.id, {
          action: 'SEND_PHOTOS_BATCH',
          data: { files: batch, caption: isLastBatch ? categoryName : null },
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

      // Gruplar arasi bekleme (WhatsApp islesin)
      if (!isLastBatch) {
        const waitMs = Math.max(5000, batch.length * 1500);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }

    showToast(allFiles.length + ' foto gonderildi!', 'success');
    await trackShareToContact();
  } catch (err) {
    showToast('Gonderilemedi: ' + err.message, 'error');
  } finally {
    isSending = false;
    btnElement.classList.remove('sending');
    countEl.textContent = originalCount;
  }
}

// --- Send All Categories ---
function handleSendAllClick() {
  if (isSending) {
    // Zaten gonderim devam ediyorsa iptal et
    sendAllCancelled = true;
    return;
  }
  sendAllCategories();
}

async function sendAllCategories() {
  if (isSending) return;
  if (categories.size === 0) return;

  isSending = true;
  sendAllCancelled = false;

  // Buton iptal moduna gec
  btnSendAll.classList.add('sending');
  sendAllLabel.textContent = 'Iptal';

  // DOM sirasini kullan (kullanicinin ayarladigi siralama)
  const domOrder = Array.from(categoryListEl.querySelectorAll('.category-btn'))
    .map(b => b.querySelector('.cat-name').textContent);
  const allSorted = domOrder
    .filter(name => categories.has(name))
    .map(name => [name, categories.get(name)]);
  // Secili kategoriler varsa sadece onlari gonder
  const sorted = selectedCategories.size > 0
    ? allSorted.filter(([name]) => selectedCategories.has(name))
    : allSorted;
  const total = sorted.length;
  if (total === 0) { isSending = false; return; }
  let sent = 0;
  let failed = 0;

  try {
    const tab = await getWhatsAppTab();
    await ensureContentScript(tab);

    for (let i = 0; i < sorted.length; i++) {
      if (sendAllCancelled) {
        showToast('Gonderim iptal edildi (' + sent + '/' + total + ')', 'info');
        break;
      }

      const [name, files] = sorted[i];
      sendAllLabel.textContent = (i + 1) + '/' + total + ' ' + name;
      showToast((i + 1) + '/' + total + ' - ' + name + ' gonderiliyor...', 'info');

      // Kategori butonunu bul (gorsel feedback)
      const btns = categoryListEl.querySelectorAll('.category-btn');
      let btnElement = null;
      for (const btn of btns) {
        const nameEl = btn.querySelector('.cat-name');
        if (nameEl && nameEl.textContent === name) {
          btnElement = btn;
          break;
        }
      }
      if (btnElement) btnElement.classList.add('sending');

      try {
        // Dosyalari oku (bulunamayanları atla)
        const allFiles = [];
        for (const fileInfo of files) {
          try {
            allFiles.push(await getFileData(fileInfo));
          } catch (e) {
            console.warn('[WPPhoto] Dosya okunamadi, atlaniyor: ' + fileInfo.name);
          }
        }

        if (allFiles.length === 0) {
          throw new Error('Hicbir dosya okunamadi');
        }

        // Boyuta gore gruplara bol ve sirayla gonder
        const batches = splitIntoBatches(allFiles);
        for (let b = 0; b < batches.length; b++) {
          if (sendAllCancelled) break;
          const batch = batches[b];
          const isLastBatch = b === batches.length - 1;

          await new Promise((resolve, reject) => {
            chrome.tabs.sendMessage(tab.id, {
              action: 'SEND_PHOTOS_BATCH',
              data: { files: batch, caption: isLastBatch ? name : null },
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

          if (!isLastBatch) {
            const waitMs = Math.max(5000, batch.length * 1500);
            await new Promise(r => setTimeout(r, waitMs));
          }
        }

        sent++;
        showToast((i + 1) + '/' + total + ' - ' + name + ' gonderildi', 'success');
        await trackShareToContact();
      } catch (err) {
        failed++;
        showToast(name + ' gonderilemedi: ' + err.message, 'error');
      }

      if (btnElement) btnElement.classList.remove('sending');

      // Sonraki kategori oncesi bekle (WhatsApp'in islemi tamamlamasi icin)
      if (i < sorted.length - 1 && !sendAllCancelled) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    if (!sendAllCancelled) {
      const msg = sent + ' kategori gonderildi' + (failed ? ', ' + failed + ' basarisiz' : '');
      showToast(msg, failed ? 'info' : 'success');
    }
  } catch (err) {
    showToast('Hata: ' + err.message, 'error');
  } finally {
    isSending = false;
    sendAllCancelled = false;
    btnSendAll.classList.remove('sending');
    // Secimleri temizle
    selectedCategories.clear();
    categoryListEl.querySelectorAll('.category-btn').forEach(b => b.classList.remove('selected'));
    updateSendAllButton();
  }
}

// --- File helpers ---
async function getFileData(fileInfo) {
  const file = await fileInfo.handle.getFile();
  const arrayBuffer = await file.arrayBuffer();
  const base64 = arrayBufferToBase64(arrayBuffer);
  return { base64, fileName: file.name, mimeType: file.type || 'image/jpeg' };
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunks = [];
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    chunks.push(String.fromCharCode.apply(null, chunk));
  }
  return btoa(chunks.join(''));
}

// --- WhatsApp Tab ---
async function getWhatsAppTab() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab && activeTab.url && activeTab.url.includes('web.whatsapp.com')) {
    return activeTab;
  }

  const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  if (tabs.length) return tabs[0];

  throw new Error('WhatsApp Web acik degil!');
}

async function ensureContentScript(tab) {
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'PING' });
    if (response && response.ready) return;
  } catch (e) {
    // Content script yok, inject et
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content.js'],
  });
  await new Promise(r => setTimeout(r, 500));
}

// --- UI Helpers ---
function isImage(filename) {
  const ext = '.' + filename.split('.').pop().toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

function showEmptyState() {
  emptyState.classList.remove('hidden');
  categoryListEl.innerHTML = '';
  hideLoading();
}

function showLoading() {
  loadingEl.classList.remove('hidden');
  emptyState.classList.add('hidden');
  categoryListEl.innerHTML = '';
}

function hideLoading() {
  loadingEl.classList.add('hidden');
}

function showToast(message, type = 'info') {
  const existing = toastContainer.querySelectorAll('.toast.' + type);
  existing.forEach(t => t.remove());

  const toast = document.createElement('div');
  toast.className = 'toast ' + type;

  const icons = { success: '\u2713', error: '\u2717', info: '\u2139' };
  toast.textContent = (icons[type] || '') + ' ' + message;

  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}
