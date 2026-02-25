// WPPhoto v3 - All configuration constants
WP.config = {
  IMAGE_EXTENSIONS: new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']),

  // Chrome structured clone handles ArrayBuffers natively.
  // Keep batches under 50MB raw file size for safety (Chrome limit ~64MB).
  BATCH_MAX_BYTES: 50 * 1024 * 1024,

  // IndexedDB config
  DB_NAME: 'wpphoto-store',
  STORE_NAME: 'keyval',
  DIR_HANDLE_KEY: 'directory-handle',

  // Wait durations (ms) - each has a reason
  WAIT: {
    PASTE_SETTLE: 3000,       // WhatsApp needs time to process pasted files and show media preview
    CAPTION_RETRY: 500,       // Interval between retries to find caption input
    CAPTION_RETRIES: 5,       // Max number of caption input search attempts
    CAPTION_FOCUS: 300,       // After focusing caption input before Enter
    SEND_SETTLE: 3000,        // After pressing send, wait for media preview to close
    TEXT_FOCUS: 500,           // After focusing compose box for text input
    TEXT_SEND: 500,            // After pressing Enter for text message
    TEXT_VERIFY: 1000,         // After pressEnter, wait before verifying compose box is empty
    COMPOSE_FOCUS: 300,       // After focusing compose box before paste
    SEARCH_ICON: 600,         // After clicking search icon in sidebar
    SEARCH_TYPE: 300,         // After focusing search box before typing
    SEARCH_RESULTS: 1500,     // After typing search term, wait for results
    CHAT_SWITCH_CHECK: 500,   // Polling interval to check if chat switched
    CHAT_SWITCH_MAX: 10,      // Max polls for chat switch (10 * 500ms = 5s)
    INTER_BATCH: (count) => Math.max(3000, count * 800),   // Between photo batches
    INTER_CATEGORY: 5000,     // Between categories in send-all
    INTER_TRIGGER: 10000,     // After auto-trigger send, wait before next queue item
    CONTENT_INJECT: 500,      // After injecting content script via executeScript
    WHATSAPP_ACTIVE_TIMEOUT: 60000,  // Max wait for WhatsApp tab to become active
    WHATSAPP_ACTIVE_POLL: 1000,      // Poll interval for active tab check
  },

  TOAST_DURATION: 3000,

  // Minimum characters required for chat name substring match
  CHAT_NAME_MIN_MATCH: 3,
};
