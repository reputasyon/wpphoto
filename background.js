// WPPhoto - Background Service Worker

// Icon'a tiklaninca side panel ac
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Content script'ten gelen istekleri MAIN world'de calistir
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'CLICK_ELEMENT' && sender.tab) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN',
      func: (selector, index) => {
        const els = document.querySelectorAll(selector);
        if (els[index]) {
          els[index].click();
          return true;
        }
        return false;
      },
      args: [message.selector, message.index || 0],
    }).then(results => {
      sendResponse({ success: results?.[0]?.result || false });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (message.action === 'CLICK_SEND_BUTTON' && sender.tab) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN',
      func: () => {
        // Gonder butonunu bul (birden fazla selector dene)
        const selectors = [
          '[data-testid="send"]',
          'span[data-icon="send"]',
          'button[aria-label="Send"]',
          'button[aria-label="Gönder"]',
          '[data-testid="compose-btn-send"]',
          'span[data-icon="send-light"]',
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) {
            const btn = el.closest('button') || el;
            btn.click();
            return sel;
          }
        }
        // Alternatif: yesil daire buton (media preview'daki)
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const svg = btn.querySelector('svg');
          if (svg && btn.offsetHeight > 0 && btn.offsetHeight < 70) {
            const path = btn.querySelector('path[d*="M1.101"]');
            if (path) { btn.click(); return 'svg-path'; }
          }
        }
        return false;
      },
      args: [],
    }).then(results => {
      const found = results?.[0]?.result;
      sendResponse({ success: !!found, selector: found });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // Media preview'da son fotografa git
  if (message.action === 'CLICK_LAST_THUMB' && sender.tab) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN',
      func: () => {
        // Thumbnail strip'teki tum tiklanabilir ogeler
        // WhatsApp media preview'da kucuk thumbnail'lar genelde bir satir halinde
        const containers = document.querySelectorAll(
          '[data-testid="media-pip"], [data-testid="thumb-image"], [data-testid="media-thumb"]'
        );
        if (containers.length > 1) {
          containers[containers.length - 1].click();
          return { method: 'testid', count: containers.length };
        }

        // Alternatif: preview alanindaki kucuk resimler (thumbnail boyutu)
        const allImgs = document.querySelectorAll('img');
        const thumbs = [];
        for (const img of allImgs) {
          const rect = img.getBoundingClientRect();
          // Thumbnail boyutu: kucuk kareler (40-80px arasi)
          if (rect.width > 30 && rect.width < 100 && rect.height > 30 && rect.height < 100) {
            // Ayni container icinde birden fazla varsa thumbnail strip'i
            thumbs.push(img);
          }
        }
        if (thumbs.length > 1) {
          const last = thumbs[thumbs.length - 1];
          last.click();
          // Tiklama calismadiysa parent'a da tikla
          if (last.parentElement) last.parentElement.click();
          return { method: 'img-size', count: thumbs.length };
        }

        // Son alternatif: preview icerigindeki tum tiklanabilir kucuk div'ler
        const mediaArea = document.querySelector('[data-testid="media-editor"]')
          || document.querySelector('[data-testid="media-editor-container"]')
          || document.querySelector('[role="dialog"]');
        if (mediaArea) {
          const smallDivs = mediaArea.querySelectorAll('div[role="button"], div[tabindex]');
          const candidates = [];
          for (const d of smallDivs) {
            const rect = d.getBoundingClientRect();
            if (rect.width > 30 && rect.width < 120 && rect.height > 30 && rect.height < 120) {
              candidates.push(d);
            }
          }
          if (candidates.length > 1) {
            candidates[candidates.length - 1].click();
            return { method: 'div-button', count: candidates.length };
          }
        }

        return { method: 'none', count: 0 };
      },
      args: [],
    }).then(results => {
      const info = results?.[0]?.result || {};
      console.log('[WPPhoto] Last thumb:', info);
      sendResponse({ success: info.count > 0, ...info });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // chrome.debugger ile güvenilir tus gonder (genel)
  if (message.action === 'PRESS_KEY_DEBUGGER' && sender.tab) {
    const tabId = sender.tab.id;
    const debuggee = { tabId };
    const key = message.key || 'Enter';
    const code = message.code || key;
    const keyCode = message.keyCode || 13;
    const count = message.count || 1;

    chrome.debugger.attach(debuggee, '1.3', () => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
        return;
      }

      let sent = 0;
      function sendNext() {
        if (sent >= count) {
          chrome.debugger.detach(debuggee, () => {
            sendResponse({ success: true, sent });
          });
          return;
        }
        chrome.debugger.sendCommand(debuggee, 'Input.dispatchKeyEvent', {
          type: 'keyDown', key, code,
          windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
        }, () => {
          chrome.debugger.sendCommand(debuggee, 'Input.dispatchKeyEvent', {
            type: 'keyUp', key, code,
            windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
          }, () => {
            sent++;
            setTimeout(sendNext, 150);
          });
        });
      }
      sendNext();
    });
    return true;
  }

  // chrome.debugger ile güvenilir Enter tuşu gönder (multi-monitor uyumlu)
  if (message.action === 'PRESS_ENTER_DEBUGGER' && sender.tab) {
    const tabId = sender.tab.id;
    const debuggee = { tabId };

    chrome.debugger.attach(debuggee, '1.3', () => {
      if (chrome.runtime.lastError) {
        console.warn('[WPPhoto] Debugger attach hatasi:', chrome.runtime.lastError.message);
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
        return;
      }

      // keyDown
      chrome.debugger.sendCommand(debuggee, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      }, () => {
        // keyUp
        chrome.debugger.sendCommand(debuggee, 'Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        }, () => {
          // Debugger'i kapat
          chrome.debugger.detach(debuggee, () => {
            sendResponse({ success: true });
          });
        });
      });
    });

    return true;
  }
});
