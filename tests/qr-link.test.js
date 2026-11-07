// Live test (needs internet): the login link shown in the app must be the same
// short link that is drawn inside TikTok's QR, also after asking for a new QR.
//   npm run test:qr
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const jsQR = require('jsqr');
const ROOT = path.join(__dirname, '..');
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-recharge-qr-'));

async function screenQr(app) {
  const s = await app.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => /tiktok\.com/.test(w.getURL()));
    const img = await wc.capturePage();
    const bmp = img.toBitmap();
    let { width, height } = img.getSize();
    if (bmp.length !== width * height * 4) { const k = Math.sqrt(bmp.length / (4 * width * height)); width = Math.round(width * k); height = Math.round(height * k); }
    return { b64: bmp.toString('base64'), width, height };
  });
  const bgra = Buffer.from(s.b64, 'base64');
  const rgba = new Uint8ClampedArray(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) { rgba[i] = bgra[i + 2]; rgba[i + 1] = bgra[i + 1]; rgba[i + 2] = bgra[i]; rgba[i + 3] = 255; }
  const c = jsQR(rgba, s.width, s.height);
  return c ? c.data : null;
}

async function waitLink(page, not = '') {
  for (let i = 0; i < 30; i++) {
    const v = await page.inputValue('#qr-url');
    if (v && v !== not) return v;
    await page.waitForTimeout(1000);
  }
  return '';
}

(async () => {
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [ROOT],
    env: { ...process.env, TT_USER_DATA: UD },
  });
  const page = await app.firstWindow();
  let ok = true;
  try {
    await page.waitForSelector('#lock:not([hidden])');
    await page.fill('#lock-pin', '1234');
    await page.fill('#lock-pin2', '1234');
    await page.click('#lock-submit');
    await page.waitForSelector('#lock', { state: 'hidden' });
    await page.click('#btn-new');
    await page.fill('#f-name', 'qr');
    await page.click('.modal-foot .btn.primary');

    const first = await waitLink(page);
    await page.waitForTimeout(1500);
    const firstScreen = await screenQr(app);
    console.log('1st app   :', first);
    console.log('1st screen:', firstScreen);
    const m1 = first && first === firstScreen && /\/t\//.test(first);
    console.log(m1 ? 'PASS first link is the short link on screen' : 'FAIL first link');
    ok = ok && m1;

    await page.click('#qr-new');
    const second = await waitLink(page, first);
    await page.waitForTimeout(1500);
    const secondScreen = await screenQr(app);
    console.log('2nd app   :', second);
    console.log('2nd screen:', secondScreen);
    const m2 = second && second !== first && second === secondScreen;
    console.log(m2 ? 'PASS new QR gives the new short link' : 'FAIL after new QR');
    ok = ok && m2;
  } catch (e) {
    console.log('ERROR', e);
    ok = false;
  } finally {
    await app.close();
    fs.rmSync(UD, { recursive: true, force: true });
  }
  process.exit(ok ? 0 : 1);
})();
