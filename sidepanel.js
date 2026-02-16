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
const catalogBar = document.getElementById('catalog-bar');
const phoneInput = document.getElementById('phone-input');
const btnSavePhone = document.getElementById('btn-save-phone');
const btnGenerateCatalog = document.getElementById('btn-generate-catalog');

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
btnSavePhone.addEventListener('click', savePhoneNumber);
btnGenerateCatalog.addEventListener('click', generateCatalogPage);

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

// --- Phone number ---
async function loadPhoneNumber() {
  const result = await chrome.storage.local.get('whatsappPhone');
  if (result.whatsappPhone) {
    phoneInput.value = result.whatsappPhone;
  }
}

async function savePhoneNumber() {
  const phone = phoneInput.value.replace(/\D/g, '');
  if (!phone || phone.length < 10) {
    showToast('Gecerli bir telefon numarasi girin', 'error');
    return;
  }
  phoneInput.value = phone;
  await chrome.storage.local.set({ whatsappPhone: phone });
  btnSavePhone.classList.add('saved');
  showToast('Numara kaydedildi', 'success');
  setTimeout(() => btnSavePhone.classList.remove('saved'), 2000);
}

// --- Catalog page generator ---
async function generateCatalogPage() {
  if (categories.size === 0) {
    showToast('Once klasor secin', 'error');
    return;
  }

  const phone = phoneInput.value.replace(/\D/g, '');
  if (!phone || phone.length < 10) {
    showToast('Once telefon numarasini girin', 'error');
    phoneInput.focus();
    return;
  }

  // DOM sirasini kullan
  const domOrder = Array.from(categoryListEl.querySelectorAll('.category-btn'))
    .map(b => ({
      name: b.querySelector('.cat-name').textContent,
      count: categories.get(b.querySelector('.cat-name').textContent)?.length || 0,
    }))
    .filter(c => c.count > 0);

  if (domOrder.length === 0) {
    showToast('Kategori bulunamadi', 'error');
    return;
  }

  const html = buildCatalogHTML(phone, domOrder);

  // HTML dosyasini indir
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'redline.html';
  a.click();
  URL.revokeObjectURL(url);

  showToast('Katalog sayfasi indirildi!', 'success');
}

function buildCatalogHTML(phone, cats) {
  const categoryCards = cats.map(c => {
    const waLink = 'https://wa.me/' + phone + '?text=' + encodeURIComponent('#' + c.name);
    return '      <a href="' + waLink + '" class="card">\n' +
      '        <div class="card-icon">\n' +
      '          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>\n' +
      '        </div>\n' +
      '        <span class="card-name">' + c.name + '</span>\n' +
      '        <span class="card-count">' + c.count + ' foto</span>\n' +
      '        <div class="card-wa">\n' +
      '          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>\n' +
      '        </div>\n' +
      '      </a>';
  }).join('\n');

  const totalPhotos = cats.reduce((sum, c) => sum + c.count, 0);
  const sendAllLink = 'https://wa.me/' + phone + '?text=' + encodeURIComponent('#hepsi');

  return '<!DOCTYPE html>\n' +
    '<html lang="tr">\n' +
    '<head>\n' +
    '  <meta charset="UTF-8">\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">\n' +
    '  <title>Urun Katalogu</title>\n' +
    '  <style>\n' +
    '    * { margin: 0; padding: 0; box-sizing: border-box; }\n' +
    '    body {\n' +
    '      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n' +
    '      background: #0a0a0a;\n' +
    '      color: #fff;\n' +
    '      min-height: 100vh;\n' +
    '      display: flex;\n' +
    '      flex-direction: column;\n' +
    '      align-items: center;\n' +
    '    }\n' +
    '    .container {\n' +
    '      width: 100%;\n' +
    '      max-width: 480px;\n' +
    '      padding: 24px 16px 40px;\n' +
    '    }\n' +
    '    .header {\n' +
    '      text-align: center;\n' +
    '      margin-bottom: 28px;\n' +
    '    }\n' +
    '    .header h1 {\n' +
    '      font-size: 22px;\n' +
    '      font-weight: 700;\n' +
    '      margin-bottom: 6px;\n' +
    '    }\n' +
    '    .header p {\n' +
    '      font-size: 14px;\n' +
    '      color: #888;\n' +
    '    }\n' +
    '    .send-all {\n' +
    '      display: flex;\n' +
    '      align-items: center;\n' +
    '      justify-content: center;\n' +
    '      gap: 10px;\n' +
    '      width: 100%;\n' +
    '      padding: 16px;\n' +
    '      margin-bottom: 16px;\n' +
    '      background: #25D366;\n' +
    '      border-radius: 14px;\n' +
    '      text-decoration: none;\n' +
    '      color: #fff;\n' +
    '      font-size: 16px;\n' +
    '      font-weight: 700;\n' +
    '      transition: all 0.2s;\n' +
    '    }\n' +
    '    .send-all:active {\n' +
    '      transform: scale(0.97);\n' +
    '      background: #1ebe59;\n' +
    '    }\n' +
    '    .send-all svg {\n' +
    '      width: 22px;\n' +
    '      height: 22px;\n' +
    '    }\n' +
    '    .send-all-count {\n' +
    '      font-size: 13px;\n' +
    '      font-weight: 400;\n' +
    '      opacity: 0.85;\n' +
    '    }\n' +
    '    .grid {\n' +
    '      display: grid;\n' +
    '      grid-template-columns: 1fr 1fr;\n' +
    '      gap: 12px;\n' +
    '    }\n' +
    '    .card {\n' +
    '      display: flex;\n' +
    '      flex-direction: column;\n' +
    '      align-items: center;\n' +
    '      gap: 10px;\n' +
    '      padding: 20px 12px;\n' +
    '      background: #1a1a1a;\n' +
    '      border: 1px solid #2a2a2a;\n' +
    '      border-radius: 14px;\n' +
    '      text-decoration: none;\n' +
    '      color: #fff;\n' +
    '      transition: all 0.2s;\n' +
    '      position: relative;\n' +
    '    }\n' +
    '    .card:active {\n' +
    '      transform: scale(0.96);\n' +
    '      border-color: #25D366;\n' +
    '    }\n' +
    '    .card-icon {\n' +
    '      width: 44px;\n' +
    '      height: 44px;\n' +
    '      background: #252525;\n' +
    '      border-radius: 12px;\n' +
    '      display: flex;\n' +
    '      align-items: center;\n' +
    '      justify-content: center;\n' +
    '    }\n' +
    '    .card-icon svg {\n' +
    '      width: 22px;\n' +
    '      height: 22px;\n' +
    '      color: #25D366;\n' +
    '    }\n' +
    '    .card-name {\n' +
    '      font-size: 14px;\n' +
    '      font-weight: 600;\n' +
    '      text-align: center;\n' +
    '      line-height: 1.3;\n' +
    '    }\n' +
    '    .card-count {\n' +
    '      font-size: 12px;\n' +
    '      color: #666;\n' +
    '    }\n' +
    '    .card-wa {\n' +
    '      position: absolute;\n' +
    '      top: 10px;\n' +
    '      right: 10px;\n' +
    '      width: 20px;\n' +
    '      height: 20px;\n' +
    '      color: #25D366;\n' +
    '    }\n' +
    '    .card-wa svg {\n' +
    '      width: 100%;\n' +
    '      height: 100%;\n' +
    '    }\n' +
    '  </style>\n' +
    '</head>\n' +
    '<body>\n' +
    '  <div class="container">\n' +
    '    <div class="header">\n' +
    '      <h1>Urun Katalogu</h1>\n' +
    '      <p>Gormek istediginiz kategoriyi secin</p>\n' +
    '    </div>\n' +
    '    <a href="' + sendAllLink + '" class="send-all">\n' +
    '      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>\n' +
    '      <span>Tumunu Gonder</span>\n' +
    '      <span class="send-all-count">(' + totalPhotos + ' foto)</span>\n' +
    '    </a>\n' +
    '    <div class="grid">\n' +
    categoryCards + '\n' +
    '    </div>\n' +
    '  </div>\n' +
    '</body>\n' +
    '</html>';
}

// --- Auto-trigger: #kategori dinle ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!autoModeEnabled) return; // Kapaliysa yok say

  if (message.action === 'AUTO_SEND_TRIGGER') {
    if (message.category.toLowerCase() === 'hepsi') {
      handleAutoSendAll();
    } else {
      handleAutoSend(message.category);
    }
  }
});

async function handleAutoSend(triggerCategory) {
  // Baska gonderim devam ediyorsa bekle (selamlama vs.)
  let retries = 0;
  while (isSending && retries < 10) {
    await new Promise(r => setTimeout(r, 2000));
    retries++;
  }
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

async function handleAutoSendAll() {
  // Baska gonderim devam ediyorsa bekle
  let retries = 0;
  while (isSending && retries < 10) {
    await new Promise(r => setTimeout(r, 2000));
    retries++;
  }
  if (isSending) return;
  if (categories.size === 0) return;

  showToast('#hepsi algilandi, tum kategoriler gonderiliyor...', 'info');
  await sendAllCategories();
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
    catalogBar.classList.remove('hidden');
    sendAllBar.classList.remove('hidden');
    dailyStatsEl.classList.remove('hidden');
    renderCategoryButtons();
    loadAutoMode();
    loadDailyStats();
    loadPhoneNumber();
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
