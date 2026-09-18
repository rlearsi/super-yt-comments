# Super YouTube Comments 💬▶️

Google Chrome extension that proactively detects YouTube comments containing timestamps (e.g. `2:24`, `01:15:30`) and renders them directly over the video player at the exact moment mentioned.

---

## ✨ Features

- 🔍 **Proactive Comment Detection** — Automatically fetches and scans video comments in the background using YouTube's InnerTube API. **No need to scroll down** to load comments!
- 📄 **Deep Pagination** — Paginates through comment batches to capture timestamps across the entire video.
- 🎬 **In-Player Overlay** — Seamlessly embedded in the bottom-left corner of the video player, fully visible in theater and full-screen modes.
- 🎨 **Glassmorphism UI** — Sleek modern card showing author avatar, channel name, clickable timestamp badge, and comment body.
- 🚀 **Smooth Animations** — Fluid elastic pop-in transition with a configurable display duration (4s to 20s).
- ⏳ **Visual Progress Bar** — Displays remaining display time directly on the card.
- ⏸️ **Interactive Overlays** — Hover over a card to pause the countdown timer, click to expand lengthy comments, or close early via the dismiss button.
- 📋 **Extension Popup** — View a comprehensive list of all discovered timestamps; click any timestamp to jump directly to that moment.
- ⏯️ **Instant Toggle** — Easily enable or disable overlays on the fly without refreshing the page.
- 🔄 **YouTube SPA Compatibility** — Accurately detects YouTube's single-page application (SPA) navigation, clearing stale overlays and immediately fetching timestamps for new videos.

---

## 📦 How to Install (Developer Mode)

> This extension is loaded locally as an unpacked extension. Follow the instructions below to install it.

### Prerequisites
- Google Chrome (version 114 or higher recommended) or any Chromium-based browser (Brave, Edge, Opera, etc.)

### Step-by-Step Installation

1. Open **Google Chrome** and navigate to:
   ```
   chrome://extensions
   ```

2. Enable **Developer mode** using the toggle switch in the top-right corner.

3. Click the **Load unpacked** button in the top-left corner.

4. Select the project directory:
   ```
   /opt/lampp/htdocs/super-yt-comments/
   ```

5. The extension will now appear in your extensions list with the 🎬💬 icon. **You're all set!**

---

## 🚀 How to Use

1. Go to [youtube.com](https://www.youtube.com) and open any video.
2. The extension automatically fetches and indexes comments in the background — you **do not** need to scroll down to load them.
3. When the video playback reaches any timestamp mentioned in a comment, the card will automatically appear over the player.
4. Click the **Super YouTube Comments** icon in your browser toolbar to see all detected timestamps and jump directly to any highlighted moment.

---

## ⚙️ Configuration (via Popup)

| Option | Description |
|:---|:---|
| **Enable / Disable** | Toggle overlay visibility on or off without reloading the page |
| **Duration** | Adjust how long each card stays on screen (4s – 20s) |
| **Timestamp Directory** | Click any timestamp in the list to jump instantly to that moment in the video |
| **↻ Refresh** | Manually force a re-fetch and scan of the current video's comments |

---

## 🗂️ Project Structure

```
super-yt-comments/
├── manifest.json        ← Extension configuration (Manifest V3)
├── injected.js          ← Main-world script for proactive InnerTube API comment fetching
├── content.js           ← Content script managing player overlays, timing, and UI
├── styles.css           ← Overlay styling, animations, and glassmorphism themes
├── popup.html           ← Extension popup interface
├── popup.js             ← Popup logic and timestamp directory navigation
├── icons/               ← Extension icons (16px, 48px, 128px)
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── ChangeLog.txt        ← Version release notes and update history
└── README.md            ← Project documentation
```

---

## 🔧 Technical Details

- Built with **Chrome Manifest V3** standards.
- Employs a dual-layer script architecture:
  - `injected.js` operates in the page's `MAIN` world to communicate directly with YouTube's internal `ytcfg` context and proactively fetch comment continuations via the same-origin InnerTube API.
  - `content.js` runs in the `ISOLATED` world, synchronizing playback time, listening for video navigations, and injecting UI elements.
- Overlays are injected directly into YouTube's `.html5-video-player` container to ensure persistence across windowed, theater, and fullscreen view modes.

---

## 📝 Changelog

See [ChangeLog.txt](ChangeLog.txt) for version history and release notes.

---

*Built with ❤️ — Super YouTube Comments v1.6.3*
