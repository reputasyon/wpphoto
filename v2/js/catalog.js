// WPPhoto v2 - XSS-safe catalog HTML generator
WP.catalog = {

  generatePage() {
    if (WP.state.categories.size === 0) {
      WP.utils.showToast('Once klasor secin', 'error');
      return;
    }

    const phone = document.getElementById('phone-input').value.replace(/\D/g, '');
    if (!phone || phone.length < 10) {
      WP.utils.showToast('Once telefon numarasini girin', 'error');
      document.getElementById('phone-input').focus();
      return;
    }

    // Get categories in DOM order
    const categoryListEl = document.getElementById('category-list');
    const domOrder = Array.from(categoryListEl.querySelectorAll('.category-btn'))
      .map(b => ({
        name: b.querySelector('.cat-name').textContent,
        count: WP.state.categories.get(b.querySelector('.cat-name').textContent)?.length || 0,
      }))
      .filter(c => c.count > 0);

    if (domOrder.length === 0) {
      WP.utils.showToast('Kategori bulunamadi', 'error');
      return;
    }

    const html = WP.catalog._buildHTML(phone, domOrder);

    // Download as HTML file
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'redline.html';
    a.click();
    URL.revokeObjectURL(url);

    WP.utils.showToast('Katalog sayfasi indirildi!', 'success');
  },

  _buildHTML(phone, cats) {
    const esc = WP.utils.escapeHtml;
    const escapedPhone = esc(phone);

    const totalPhotos = cats.reduce((sum, c) => sum + c.count, 0);
    const sendAllLink = 'https://wa.me/' + escapedPhone + '?text=' + encodeURIComponent('#hepsi');

    const waSvg = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>';

    const categoryCards = cats.map(c => {
      const escapedName = esc(c.name);
      const escapedCount = esc(String(c.count));
      const waLink = 'https://wa.me/' + escapedPhone + '?text=' + encodeURIComponent('#' + c.name);

      return '      <a href="' + esc(waLink) + '" class="card">\n' +
        '        <div class="card-icon">\n' +
        '          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>\n' +
        '        </div>\n' +
        '        <span class="card-name">' + escapedName + '</span>\n' +
        '        <span class="card-count">' + escapedCount + ' foto</span>\n' +
        '        <div class="card-wa">' + waSvg + '</div>\n' +
        '      </a>';
    }).join('\n');

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
      '    <a href="' + esc(sendAllLink) + '" class="send-all">\n' +
      '      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>\n' +
      '      <span>Tumunu Gonder</span>\n' +
      '      <span class="send-all-count">(' + esc(String(totalPhotos)) + ' foto)</span>\n' +
      '    </a>\n' +
      '    <div class="grid">\n' +
      categoryCards + '\n' +
      '    </div>\n' +
      '  </div>\n' +
      '</body>\n' +
      '</html>';
  },
};
