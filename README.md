# Camera Detector

Find hidden camera lenses with your phone, **even with the lights on**.

Most hidden-camera finder apps ask you to turn the lights off and look for a glint by eye. This one doesn't need a dark room. It blinks your phone's flashlight and lets the camera do the looking.

## How it works

A camera lens is a **retroreflector**: light that goes into it bounces almost straight back to where it came from (the same effect that makes cats' eyes shine in headlights). Your phone's flashlight sits right next to its camera, so a hidden lens in front of you lights up far more than anything around it.

**Flash scan** blinks the flashlight about twice a second and compares each "flash on" frame with the "flash off" frames on either side:

- **Room lighting cancels out.** Lamps, windows and daylight are the same in both frames, so they don't show up.
- **Surface texture cancels out.** Frames are compared as a *ratio*. A white wall and a grey wall both get brighter by the same factor when the flash hits them; a lens glint gets brighter by a far bigger factor.
- **Hand shake cancels out.** The flash-off frames are lined up with the flash-on frame before comparing, and each pixel is compared with the brightest flash-off pixel right next to it.
- **Only small round spots count.** Lines, edges and big shiny patches (mirrors, screens) are rejected, and a spot has to show up in the same place on consecutive blinks before it's flagged.

What's left gets a red **Possible lens** marker.

If the browser can't control the flashlight, the app falls back to **Spot scan**, which looks for tiny bright points in each frame. It's less selective, and works best with another light held right next to the camera, or in a dark room for the night-vision check below.

## Features

- **Flash scan** (lit rooms), plus **Spot scan** as a fallback
- **Night-vision check**: switch to the front camera in a dark room to spot infrared LEDs, which show up as purple or white dots
- Three views: **Normal**, **Red filter** (classic glint-spotting view) and **Glow map** (shows exactly what reacted to the flash)
- Sensitivity slider, vibration and an optional beep on detection
- **Snapshot** button saves or shares the current view with markers and a timestamp
- Installable on your home screen, works offline, keeps the screen awake while scanning
- **Private**: everything runs on the phone. No video is uploaded anywhere.
- The flash blinks at no more than ~2.5 times a second, and blinking can be turned off in settings

## Browser support

| | Flash scan | Spot scan |
|---|---|---|
| Chrome / Edge / Samsung Internet on Android | ✅ | ✅ |
| Safari and other iPhone browsers | only if the browser allows flashlight control | ✅ |
| Desktop browsers | — (no flashlight) | ✅ |

The app checks what your browser supports and picks the right mode automatically.

## Put it on your phone

The camera only works on a secure (`https://`) page, so it needs to be hosted. The easiest free option is GitHub Pages:

1. Merge this branch into `main`.
2. In the repo on GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, pick `main` and `/ (root)`, then **Save**.
3. After a minute it's live at `https://<your-username>.github.io/Camera-detector/`.
4. Open that link on your phone. To install it, use **Add to Home screen** (Chrome menu ⋮, or Safari's Share button).

Any static host works (Netlify, Vercel, Cloudflare Pages); there's no build step.

## Run it locally

```sh
npm start          # serves the app at http://localhost:8080
```

`localhost` counts as secure, so the camera works in a desktop browser there. A phone on the same Wi-Fi can't use the camera over plain `http://`, so use the hosted version for phones.

## Tests

```sh
npm test           # unit tests for the detection maths (Node 18+)
npm run test:e2e   # full app in headless Chromium with a simulated camera + flashlight
```

The end-to-end test fakes a phone camera showing a lit room with an always-on lamp and a small object hiding a lens that only glints while the app has the flashlight on, with simulated hand shake. It checks that Flash scan finds the lens, ignores the lamp and raises no false alarms, that Spot scan works without flashlight control, and that the flashlight is off after stopping. It uses Playwright (`npm i -D playwright` if it isn't installed).

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
```

## Limits

No app can promise to find every hidden camera. A lens behind tinted glass, pointed away from you, or with no line of sight to your phone won't glint. Shiny screws, glass, jewellery and pets' eyes can cause false alarms, so always check flagged spots with your own eyes. A real lens looks like a tiny dark circle that glints when light hits it.
