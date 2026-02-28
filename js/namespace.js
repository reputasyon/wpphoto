// WPPhoto v2 - Shared namespace for all side panel modules
window.WP = {
  state: {
    categories: new Map(),
    dirHandle: null,
    isSending: false,
    sendAllCancelled: false,
    autoModeEnabled: false,
    selectedCategories: new Set(),
    categoryOrder: [],
  },
};
