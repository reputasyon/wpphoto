// WPPhoto v3 - Shared utilities
WP.utils = {
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  },

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  isImage(filename) {
    const ext = '.' + filename.split('.').pop().toLowerCase();
    return WP.config.IMAGE_EXTENSIONS.has(ext);
  },

  arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunks = [];
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
    }
    return btoa(chunks.join(''));
  },

  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    container.querySelectorAll('.toast.' + type).forEach(t => t.remove());

    const icons = { success: '\u2713', error: '\u2717', info: '\u2139' };
    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.textContent = (icons[type] || '') + ' ' + message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 300);
    }, WP.config.TOAST_DURATION);
  },
};
