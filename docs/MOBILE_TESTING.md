# Testing on phones

What runs where, and what's still open.

## On every push (`.github/workflows/test.yml`)

| Job | What it covers |
|---|---|
| `e2e`, project `phone` | Chromium at Pixel 7 size with touch. `e2e/mobile.spec.js` sends real touch events through Chromium's DevTools protocol: swiping the looks, dragging a slider, holding a finger on the photo to compare (and no image menu). Also: every width from 320 to 412 px upright and sideways (no sideways scroll, 44 px targets, zoom allowed), controls staying clear of the sticky photo and Transform bar, axe's WCAG 2.2 A/AA checks, and a phone slowed 4x on slow 4G. |
| `e2e`, project `iphone` | The same in Playwright's WebKit (Safari's engine) at iPhone 15 size. WebKit has no real touch events here, so gestures are skipped and taps use Playwright's `tap()`. It's WebKit's Linux build, not iOS: no WebGPU and no camera. |
| `lighthouse` | Lighthouse's mobile audit (a mid-range phone on slow 4G) of the production build, against the budgets in `lighthouserc.js`. |

## Nightly and on demand (`.github/workflows/mobile-devices.yml`)

Smoke tests in real mobile browsers. Each checks that the page loads and fits, that a photo can be made, and that the work survives a reload. Each puts the browser's version and whether it has WebGPU on the run's summary page.

| Job | Browser | Driven by |
|---|---|---|
| `android` | Chrome 113 on Android 14 (the emulator's `google_apis` image, which has no Play Store, so Chrome never updates). No WebGPU. | Playwright's experimental Android support (`e2e/android/`) |
| `ios` | Safari 26.5 on iOS 18.7 (an iPhone 17 Pro simulator on `macos-26`). No WebGPU in the simulator. | Apple's `safaridriver`, from `e2e/ios/safari.js` |

Both click from inside the page, not by touching the screen, because of the open issues below.

## Open issues, to look at again

Both were found in October 2026. Neither has a documented cause that I could find.

- **Android: taps on the emulator's screen never reach Chrome's page.** Neither `adb shell input tap` nor Playwright's `device.input.tap` worked. The tab was visible and focused, and Chrome had the window focus, yet the page saw no touch, pointer, mouse or click events. Things to try:
  - a newer system image, or one with the Play Store so Chrome can update
  - `-gpu host` or `-gpu guest` instead of `swiftshader_indirect`
  - Chrome's `--enable-features=` flags for touch
  - checking the screenshot artifact for something covering the page
  - Appium's UiAutomator2 driver, which injects input differently
- **iOS: WebDriver touch actions land in the wrong place.** On one tap a touch landed where it was aimed; on the next it landed 84 px above. Once, a touch was refused as "move target out of bounds". Element clicks also landed on other buttons, and once Safari stopped answering afterwards. The offset changing suggests Safari's toolbar moves as the page scrolls. Things to try:
  - turning off the toolbar's collapsing, or scrolling only with `window.scrollTo` before touching
  - a simulator runtime that matches the Safari version, or an older Safari
  - Appium's XCUITest driver, which taps from outside Safari
  - the WebKit bug tracker's WebDriver component, for related bugs (for example [218232](https://bugs.webkit.org/show_bug.cgi?id=218232), touch actions returning "not implemented" in Safari 14)
- **Real phone GPUs and timings** aren't available on GitHub's runners at all. A device cloud (BrowserStack, Sauce Labs) runs Playwright on real iPhones and Android phones, if that's ever wanted.

The nightly run also tries one way round each, and reports what happened on the run's summary page without judging it (the "experiment" notices): on iOS, touches aimed at an element (WebDriver's `origin: element`, so Safari places them, not our arithmetic); on Android, taps at the middle of the screen through `adb shell input tap` and `input touchscreen swipe`, to see whether anything reaches the page at all.

When the touch problems are solved, the `ios` job's tap and hold, and the `android` job's long press (Android's image menu), can come back. Git history has the earlier versions: commits `f376a70` to `3ff422b` on the `mobile-ci` branch.
