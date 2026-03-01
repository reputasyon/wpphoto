// WPPhoto v3 - Background Service Worker

// Open side panel when extension icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Handle messages from content script and side panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // Click the send button in WhatsApp Web (executed in MAIN world)
  if (message.action === 'CLICK_SEND_BUTTON' && sender.tab) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN',
      func: () => {
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

        // Fallback: find green send circle button by SVG path
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const svg = btn.querySelector('svg');
          if (svg && btn.offsetHeight > 0 && btn.offsetHeight < 70) {
            const path = btn.querySelector('path[d*="M1.101"]');
            if (path) {
              btn.click();
              return 'svg-path';
            }
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

  // Press Enter key via chrome.debugger API (reliable across all monitors)
  if (message.action === 'PRESS_ENTER_DEBUGGER' && sender.tab) {
    const tabId = sender.tab.id;
    const debuggee = { tabId };

    chrome.debugger.attach(debuggee, '1.3', () => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
        return;
      }

      const keyParams = {
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      };

      // keyDown then keyUp then detach
      chrome.debugger.sendCommand(debuggee, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        ...keyParams,
      }, () => {
        chrome.debugger.sendCommand(debuggee, 'Input.dispatchKeyEvent', {
          type: 'keyUp',
          ...keyParams,
        }, () => {
          chrome.debugger.detach(debuggee, () => {
            sendResponse({ success: true });
          });
        });
      });
    });
    return true;
  }
});
