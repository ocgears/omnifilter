#!/usr/bin/env node
// A smoke test of Mobile Safari in the iOS Simulator, driven by Apple's own
// safaridriver (WebDriver) from the nightly mobile-devices workflow.
// Playwright can't drive iOS Safari, so this is a short script that speaks
// WebDriver directly. All as a guest.
//
// Clicks are made from inside the page. WebDriver's touch actions landed
// at varying distances from where they were aimed (0 px once, 84 px above
// the next time), so iOS's own touch handling, such as its menu for a held
// image, isn't tested here. See docs/MOBILE_TESTING.md.
//
//   safaridriver -p 4444 &
//   SIMULATOR_UDID=<udid> node e2e/ios/safari.js
//
// Each check prints a line; any failure makes the script exit with 1. What
// the browser can do (WebGPU, its version) goes on the run's summary page.
'use strict';

const fs = require('fs');
const path = require('path');
const { notice } = require('../helpers');

const DRIVER = process.env.SAFARIDRIVER_URL || 'http://localhost:4444';
const APP = 'http://localhost:' + (Number(process.env.E2E_PORT) || 3930) + '/';
const OUT = path.join(__dirname, '..', '..', 'test-results', 'ios');

async function call(method, route, body) {
  const res = await fetch(DRIVER + route, {
    // A command safaridriver never answers mustn't use up the job's time.
    signal: AbortSignal.timeout(90000),
    method: method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const v = json.value || {};
    throw new Error(method + ' ' + route + ': ' + (v.error || res.status) + ' ' + (v.message || ''));
  }
  return json.value;
}

class Session {
  static async start() {
    const capabilities = {
      browserName: 'safari',
      platformName: 'iOS',
      'safari:useSimulator': true,
      'safari:deviceType': 'iPhone'
    };
    if (process.env.SIMULATOR_UDID) capabilities['safari:deviceUDID'] = process.env.SIMULATOR_UDID;
    // Attaching to the simulator's Safari sometimes times out; try again.
    for (let attempt = 1; ; attempt++) {
      try {
        const value = await call('POST', '/session', { capabilities: { alwaysMatch: capabilities } });
        return new Session(value.sessionId, value.capabilities);
      } catch (e) {
        if (attempt === 3) throw e;
        console.log('Attempt ' + attempt + ' to start a session failed: ' + e.message);
      }
    }
  }

  constructor(id, capabilities) {
    this.base = '/session/' + id;
    this.capabilities = capabilities;
  }

  go(url) { return call('POST', this.base + '/url', { url: url }); }
  // Runs a function's body in the page; `args` arrive as `arguments`.
  run(script, ...args) { return call('POST', this.base + '/execute/sync', { script: script, args: args }); }
  runAsync(script, ...args) { return call('POST', this.base + '/execute/async', { script: script, args: args }); }
  // The page's element for a CSS selector, as WebDriver refers to it.
  find(css) {
    return call('POST', this.base + '/element', { using: 'css selector', value: css });
  }
  // Clicks the element matching `css`, or with `text`, the one of them that
  // has that text, from inside the page. (WebDriver's touch actions landed
  // at varying distances from where they were aimed; see the top.)
  // Taps the first element matching css (and saying text), once there is
  // one: what it's in may still be loading (the preset looks come from the
  // server after the page opens).
  async tap(css, text, timeout = 15000) {
    const script = 'const el = Array.from(document.querySelectorAll(arguments[0]))' +
      '.find((e) => !arguments[1] || e.textContent.trim() === arguments[1]);' +
      'if (!el) return false; el.scrollIntoView({ block: "center" }); el.click(); return true;';
    const until = Date.now() + timeout;
    while (!(await this.run(script, css, text || null))) {
      if (Date.now() > until) throw new Error('nothing matches ' + css + (text ? ' saying ' + text : ''));
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  async screenshot(name) {
    fs.mkdirSync(OUT, { recursive: true });
    const png = await call('GET', this.base + '/screenshot');
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(png, 'base64'));
  }
  end() { return call('DELETE', this.base); }

  // Waits for a script to return something truthy, and returns it.
  async until(what, script, timeout = 30000) {
    const end = Date.now() + timeout;
    for (;;) {
      const value = await this.run(script).catch(() => null);
      if (value) return value;
      if (Date.now() > end) throw new Error('timed out waiting for ' + what);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

const count = (css) => 'return document.querySelectorAll(' + JSON.stringify(css) + ').length;';

// Gives the editor a photo as the file picker would: a 96 by 64 gradient
// JPEG, made in the page (iOS's Photos picker itself can't be automated).
const CHOOSE_PHOTO = `
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 64;
  const g = canvas.getContext('2d');
  const fill = g.createLinearGradient(0, 0, 96, 0);
  fill.addColorStop(0, 'rgb(0, 0, 96)');
  fill.addColorStop(1, 'rgb(255, 128, 96)');
  g.fillStyle = fill;
  g.fillRect(0, 0, 96, 64);
  const done = arguments[arguments.length - 1];
  canvas.toBlob((blob) => {
    const files = new DataTransfer();
    files.items.add(new File([blob], 'gradient.jpg', { type: 'image/jpeg' }));
    const input = document.getElementById('file');
    input.files = files.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    done(true);
  }, 'image/jpeg', 0.9);`;

let failures = 0;
async function check(name, fn) {
  try {
    const note = await fn();
    console.log('ok      ' + name + (note ? ' (' + note + ')' : ''));
  } catch (e) {
    failures++;
    console.log('FAILED  ' + name + ': ' + e.message);
    notice('error', 'iOS Safari: ' + name, e.message);
  }
}

(async () => {
  const s = await Session.start();
  try {
    await check('opens as a guest', async () => {
      await s.go(APP);
      await s.until('the guest banner', count('.banner.guest'));
    });

    await check('says what this Safari can do', async () => {
      const about = await s.runAsync(`
        const done = arguments[arguments.length - 1];
        const adapter = navigator.gpu ? navigator.gpu.requestAdapter().catch(() => null) : Promise.resolve(null);
        adapter.then((a) => done({
          userAgent: navigator.userAgent,
          screen: innerWidth + 'x' + innerHeight + ' at ' + devicePixelRatio + 'x',
          webgpu: !!a,
          camera: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
        }));`);
      about.device = s.capabilities['safari:deviceName'] || s.capabilities.platformVersion || '';
      notice('notice', 'iOS Safari', JSON.stringify(about));
      return about.webgpu ? 'WebGPU' : 'no WebGPU';
    });

    await check('fits the screen', async () => {
      const [scrollWidth, width] = await s.run('return [document.documentElement.scrollWidth, innerWidth];');
      if (scrollWidth > width) throw new Error('the page is ' + scrollWidth + ' px wide on a ' + width + ' px screen');
    });

    await check('takes a photo and a look by tap', async () => {
      await s.runAsync(CHOOSE_PHOTO);
      await s.until('the photo', 'return !!document.querySelector("#preview[src^=\'data:image\']");');
      await s.tap('.chips .chip', 'Toy camera');
      await s.until('the look\'s layers', 'return document.querySelectorAll("li.layer").length === 3;');
      await s.tap('#undo');
      await s.until('undo', 'return document.querySelectorAll("li.layer").length === 1;');
      await s.tap('#redo');
      await s.until('redo', 'return document.querySelectorAll("li.layer").length === 3;');
    });

    await check('keeps the work in progress after a reload', async () => {
      const layers = await s.run(count('li.layer'));
      // The draft is saved shortly after each change.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await s.go(APP);
      await s.until('the restored layers', 'return document.querySelectorAll("li.layer").length === ' + layers + ';');
    });

    await check('transforms on the server', async () => {
      const device = await s.runAsync('const done = arguments[arguments.length - 1];' +
        'fetch("/device").then((r) => done(r.ok), () => done(false));');
      if (!device) return 'skipped: this runner has no OpenCL device';
      await s.tap('#transform');
      await s.until('the result', count('.photo-card'), 60000);
    });

    await s.screenshot('safari');
  } finally {
    await s.end().catch(() => {});
  }
  console.log(failures ? failures + ' failed' : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.log('FAILED  to drive Safari: ' + e.message);
  notice('error', 'iOS Safari', e.message);
  process.exit(1);
});
