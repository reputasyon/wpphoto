# WPPhoto

Chrome extension for sending product photos via WhatsApp Web. Built for sellers who manage large product catalogs.

Pick a folder, it reads your subfolders as categories, and you send photos to any chat with one click.

## How It Works

```
📁 Products/
├── 📁 Slim Fit/        → becomes a "Slim Fit" button (26 photos)
├── 📁 Oversize/        → becomes an "Oversize" button (17 photos)
├── 📁 Pants/           → becomes a "Pants" button (5 photos)
└── 📁 Address/         → becomes an "Address" button (1 photo)
```

1. Open WhatsApp Web
2. Click the WPPhoto extension icon → side panel opens
3. Select your product folder
4. Each subfolder becomes a category button
5. Click a category → photos are sent to the active chat

## Features

- **Folder-based categories** — Subfolders become send buttons automatically
- **Bulk send** — Send all photos from a category with one click
- **Send all** — Send entire catalog at once
- **Auto-reply mode** — Automatically respond to incoming messages with catalog
- **Daily stats** — Track how many shares you've sent today
- **Catalog page generator** — Generate a catalog link page for your products
- **Side panel UI** — Non-intrusive, works alongside WhatsApp Web
- **Persistent storage** — Remembers your folder selection (IndexedDB)

## Install

1. Clone this repo:
   ```bash
   git clone https://github.com/reputasyon/wpphoto.git
   ```

2. Open `chrome://extensions` in Chrome

3. Enable **Developer mode** (top right)

4. Click **Load unpacked** → select the `wpphoto` folder

5. Open [WhatsApp Web](https://web.whatsapp.com) and click the WPPhoto icon

## Tech

- Chrome Extension Manifest V3
- Side Panel API
- File System Access API
- IndexedDB for persistent storage
- Zero dependencies — pure vanilla JS

## License

MIT
