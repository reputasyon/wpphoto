# WPPhoto v4 - Degisiklikler

## Yeni Ozellik: Hikaye Tarayici (Story Scanner)

WhatsApp'ta hikaye paylasan ama son 30 gunde iletisime gecilmemis kisilere
otomatik urun fotografi gonderir.

### Nasil calisir
1. "Hikayeleri Tara" butonuna tikla
2. Sistem WhatsApp Status sekmesini acip hikaye paylasan kisileri tartar
3. Son 30 gun icinde zaten mesaj atilmis kisiler elenir (fuzzy isim eslemesi ile)
4. Kalan kisiler checkbox listesi olarak gosterilir - istemediklerini kaldir
5. "Secilenleri Gonder" tikla - sirayla chat acilir ve foto gonderilir
6. Her an "Durdur" ile iptal edilebilir

### Ayarlar (disliciye tiklayarak acilir)
- Kategori: Hangi klasordeki fotolar gonderilsin (veya tumunu)
- Gunluk limit: Bir taramada max kac kisiye gonderilsin (varsayilan 20)
- Kisi arasi bekleme: Kisiler arasi bekleme suresi saniye cinsinden (varsayilan 15sn)

### Guvenlik
- Status sekmesi acilmadan scraping yapilmaz (panel degisiklik kontrolu)
- Kullanici onaylmadan hicbir sey gonderilmez (preview listesi)
- Fuzzy isim esleme: "Ahmet" ve "Ahmet Yilmaz" ayni kisi olarak taniniyor
- Minimum 10sn kisiler arasi bekleme
- Gunluk max 50 kisi limiti

---

## v3'ten v4'e degisen dosyalar

### Yeni dosya
- `js/story-scanner.js` - Tarayici orkestrasyon modulu

### Degisen dosyalar
| Dosya | Degisiklik |
|-------|-----------|
| `manifest.json` | v4.0.0 olarak guncellendi |
| `js/constants.js` | `STORY_SCANNER` config blogu eklendi |
| `js/namespace.js` | `storyScannerRunning`, `storyScannerCancelled` state eklendi |
| `js/stats.js` | `getContactedInLast30Days()`, `trackContact()`, `isContactedRecently()` eklendi |
| `content.js` | `STATUS_SELECTORS`, `scanStoryContacts()`, `SCAN_STORY_CONTACTS` ve `SWITCH_TO_CHAT` handler'lari eklendi. Panel degisiklik dogrulamasi eklendi. |
| `sidepanel.html` | Hikaye Tarayici UI bolumu + preview listesi + script tag eklendi |
| `sidepanel.css` | Scanner, preview, checkbox, cancel buton stilleri eklendi |
| `js/app.js` | Scanner bar gosterme, event listener'lar, populateCategorySelect eklendi |

### Dokunulmayan dosyalar
- `background.js` - Degisiklik yok
- `js/sender.js` - Degisiklik yok (private metodlari scanner'dan cagriliyor)
- `js/tab.js` - Degisiklik yok
- `js/utils.js` - Degisiklik yok
- `js/idb.js` - Degisiklik yok
- `js/catalog.js` - Degisiklik yok
- `js/ui.js` - Degisiklik yok
- `js/auto-mode.js` - Degisiklik yok

## Bilinen kisitlamalar
- WhatsApp Web DOM yapisini sik degistirdigi icin Status sekmesi selectorleri
  kirilabilir. Coklu fallback selector stratejisi var ama guncel whatsapp
  versiyonunda test edilmeli.
- Console'da `[WPPhoto]` ile baslayan loglar debug icin mevcut.
