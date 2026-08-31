# Whole Page Capture

One right-click. The whole page.

Whole Page Capture is a small Chrome and Microsoft Edge extension that saves a complete webpage from top to bottom as one PNG. It runs locally, asks for no permanent website access, and puts the page back where you started.

![Verified full-page capture showing the top, middle, and bottom](docs/images/whole-page-capture-proof.png)

## What it does

1. Adds **Capture full webpage** to the normal page right-click menu.
2. Briefly scrolls through the page to load lazy content.
3. Captures and combines the visible sections into one PNG.
4. Restores the original scroll position and temporary page changes.

## Install in Chrome

1. Download `whole-page-capture.zip` from the latest release or the portfolio tool page.
2. Extract the ZIP to a permanent folder.
3. Open `chrome://extensions` and enable **Developer mode**.
4. Choose **Load unpacked** and select the extracted folder.

## Install in Edge

1. Download and extract `whole-page-capture.zip`.
2. Open `edge://extensions` and enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the extracted folder.

## Use it

Right-click an ordinary `http` or `https` webpage and choose **Capture full webpage**. Keep that tab active until the PNG download starts. Press `Esc` if you want to cancel.

## Permissions in plain English

- `contextMenus`: adds the command you explicitly choose.
- `activeTab`: grants temporary access to that one tab after the click.
- `scripting`: starts the capture code in that tab.
- `storage`: remembers only the latest plain-language result until the browser closes.

There are no host permissions and no permanent access to every website.

## Supported pages

Version 1 supports ordinary webpages that fit the current browser width and stabilize at 32,000 CSS pixels high or less. It deliberately handles lazy-loaded content, fixed headers, sticky elements, animation, display scaling, and a partial final viewport.

## Honest limitations

- Pages that scroll sideways are rejected instead of cropped.
- Endless feeds that keep growing are rejected instead of saved halfway.
- Browser-internal pages, extension stores, local files, and other protected URLs cannot be captured.
- Nested scrolling panels are not expanded into separate documents.
- Live JavaScript data can change between tiles even though CSS animation is paused.

## Privacy

Nothing is uploaded. The extension has no network calls, accounts, analytics, telemetry, or remote code. Page content, URLs, titles, and screenshots are not stored. See [PRIVACY.md](PRIVACY.md).

## Verification

The repository includes deterministic unit tests, an allowlist-only packaging check, SHA-256 release checksums, and real Chrome plus Edge evidence against a labeled 6,400-pixel fixture.

Run with Node.js 24 and PowerShell 7:

```powershell
npm install
npm run icons
npm run check
npm test
npm run package
```

## Releases

The installable archive is `dist/whole-page-capture.zip`. Verify it against `dist/whole-page-capture.zip.sha256` before loading it into your browser.

## License

[MIT](LICENSE) © 2026 Travis Jones
