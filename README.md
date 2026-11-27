# Camera Detector

Find hidden camera lenses with your phone, **even with the lights on**.

**[⬇ Download the Android app (APK)](downloads/camera-detector.apk?raw=true)** · or use it in your browser at **https://richyrach.github.io/Camera-detector/** (once GitHub Pages is switched on, see below)

Most hidden-camera finder apps ask you to turn the lights off and look for a glint by eye. This one doesn't need a dark room. It blinks your phone's flashlight and lets the camera do the looking.

## How it works

A camera lens is a **retroreflector**: light that goes into it bounces almost straight back to where it came from (the same effect that makes cats' eyes shine in headlights). Your phone's flashlight sits right next to its camera, so a hidden lens in front of you lights up far more than anything around it.

**Flash scan** blinks the flashlight about twice a second and compares each "flash on" frame with the "flash off" frames on either side:

- **Room lighting cancels out.** Lamps, windows and daylight are the same in both frames, so they don't show up.
- **Surface texture cancels out.** Frames are compared as a *ratio*. A white wall and a grey wall both get brighter by the same factor when the flash hits them; a lens glint gets brighter by a far bigger factor.
- **Hand shake cancels out.** Movement is measured in patches across the picture (shift, tilt and zoom), the flash-off frames are warped to line up with the flash-on frame, and each pixel is compared with the brightest flash-off pixel right next to it.
- **A lens is dark until lit.** A spot has to get several times brighter with the flash, far more than the rest of the picture. Already-bright details like key letters or screen pixels can't do that.
- **Movement can't fake it.** Hand shake and moving screens make details appear *and* disappear. A flash glint only ever appears. The strongest "disappearing" spot in each frame sets the bar that a real glint has to beat.
- **Lone glints only.** A hidden camera is one glint. A patch of similar glints is a glossy surface (keyboards, shiny trays) and is ignored.
- **Only small round spots count, and they must repeat.** Lines, edges and big shiny patches (mirrors, screens) are rejected, and a spot has to blink back on 3 of the last 4 flashes before it's flagged.
- **Exposure is locked while scanning** on phones that allow it, so the camera doesn't re-adjust every time the flash fires.

What's left gets a red **Possible lens** marker.

If the browser can't control the flashlight, the app falls back to **Spot scan**, which looks for tiny bright points in each frame. It's less selective, and works best with another light held right next to the camera, or in a dark room for the night-vision check below.

## Features

- **Flash scan** (lit rooms), plus **Spot scan** as a fallback
- **Night-vision check**: switch to the front camera in a dark room to spot infrared LEDs, which show up as purple or white dots
- Three views: **Normal**, **Red filter** (classic glint-spotting view) and **Glow map** (shows exactly what reacted to the flash)
- Sensitivity slider, vibration and an optional beep on detection
- **Snapshot** button saves or shares the current view with markers and a timestamp
- **Android app** (APK) or a website you can add to your home screen; works offline and keeps the screen awake while scanning
- **Private**: everything runs on the phone. No video is uploaded anywhere.
- The flash blinks at no more than ~2.5 times a second, and blinking can be turned off in settings

## Browser support

| | Flash scan | Spot scan |
|---|---|---|
| Chrome / Edge / Samsung Internet on Android | ✅ | ✅ |
| Safari and other iPhone browsers | only if the browser allows flashlight control | ✅ |
| Desktop browsers | — (no flashlight) | ✅ |

The app checks what your browser supports and picks the right mode automatically.

## Get it on your phone

### Android app

1. On your phone, download **[camera-detector.apk](downloads/camera-detector.apk?raw=true)**.
2. Open it. Android will ask you to allow installs from your browser or Files app: allow it, then tap **Install**.
3. Open **Camera Detector** and allow the camera when asked.

Because the app isn't from the Play Store, Play Protect may warn that it doesn't recognise the developer. That's expected for apps you install yourself.

Needs Android 10 or newer. Release 1.1.0, signing certificate SHA-256: `70:04:14:5a:99:e0:8c:35:50:bb:ab:d6:be:49:84:15:c3:e3:d0:76:01:85:e6:84:7e:87:22:f0:15:fe:79:57`.

### Website (any phone)

The camera only works on a secure (`https://`) page, so the website has to be hosted. GitHub Pages does that for free:

1. In the repo on GitHub, go to **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**, pick the branch (`main` once this is merged) and the `/ (root)` folder, then **Save**.
3. About a minute later it's live at **https://richyrach.github.io/Camera-detector/**. The site also links to the APK.
4. Open it on your phone. To install it like an app, use **Add to Home screen** (Chrome menu ⋮, or Safari's Share button).

Any static host works (Netlify, Vercel, Cloudflare Pages); there's no build step.

## Run it locally

```sh
npm start          # serves the app at http://localhost:8080
```

`localhost` counts as secure, so the camera works in a desktop browser there. A phone on the same Wi-Fi can't use the camera over plain `http://`, so use the hosted version for phones.

## Build the Android app

The app in `android/` is a small native wrapper that runs the same web app (copied in at build time) in Android's WebView. It passes camera permission through, saves snapshots to Photos, and makes the back button close the help sheet.

You need JDK 17+ and the Android SDK (platform 35, build-tools 35). Then:

```sh
cd android
./gradlew assembleRelease      # → app/build/outputs/apk/release/app-release.apk
```

To sign it, create `android/keystore.properties` (it's git-ignored, never commit it):

```properties
storeFile=/path/to/camera-detector-release.jks
storePassword=...
keyAlias=camera-detector
keyPassword=...
```

Without that file the release APK is built unsigned. Updates must be signed with the same key as the installed version, or Android will refuse to install them over it. Bump `versionCode` and `versionName` in `android/app/build.gradle` for each release, then copy the APK to `downloads/camera-detector.apk`.

## Tests

```sh
npm test           # unit tests for the detection maths (Node 18+)
npm run test:e2e   # full app in headless Chromium with a simulated camera + flashlight
```

The end-to-end test fakes a phone camera showing a lit room with an always-on lamp and a small object hiding a lens that only glints while the app has the flashlight on, with simulated hand shake. It checks that Flash scan finds the lens, ignores the lamp and raises no false alarms, that Spot scan works without flashlight control, and that the flashlight is off after stopping. It also runs a laptop keyboard with glossy keys, an LED strip and phone auto-exposure fighting the flash, and checks the Android app's hooks (native snapshot saving, back button, no "download the app" link inside the app). It uses Playwright (`npm i -D playwright` if it isn't installed).

## Project layout

```
index.html            app shell
styles.css            styling
js/app.js             camera, flashlight, scan loops, drawing, UI
js/detector.js        image analysis (no browser APIs, unit tested)
sw.js                 offline cache
manifest.webmanifest  home-screen install info
icons/                app icons
tests/                unit + end-to-end tests, local dev server
android/              Android app (WebView wrapper around the web app)
downloads/            the built APK
```

## Help tune it

If it flags the wrong things or misses a camera, open the **?** sheet during a Flash scan and tap **Save test capture**. It saves the last flash-off, flash-on and flash-off frames side by side as one PNG, exactly as the detector saw them. Those can be replayed through `js/detector.js` to tune it on real phones.

## Limits

No app can promise to find every hidden camera. A lens behind tinted glass, pointed away from you, or with no line of sight to your phone won't glint. Shiny screws, glass, jewellery and pets' eyes can cause false alarms, so always check flagged spots with your own eyes. A real lens looks like a tiny dark circle that glints when light hits it.
