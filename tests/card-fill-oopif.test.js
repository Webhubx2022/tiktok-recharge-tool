// Card fill into a payment form served from ANOTHER SITE than the page around it,
// like TikTok (www.tiktok.com) embedding its provider (pay-my.pipopay.com).
// Chromium runs such a frame in its own process, where keystrokes only arrive
// after a real click. The two sites are tttest://shop and tttest://pay, served
// by the app itself from tests/pages when TT_TEST_PAGES is set (no network).
//   npm run test:oopif
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-recharge-oopif-'));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
}

(async () => {
  const topUrl = 'tttest://shop/d.html';

  const app = await electron.launch({
    executablePath: require('electron'),
    args: [ROOT],
    env: { ...process.env, TT_USER_DATA: UD, TT_FILL_ANY_HOST: '1', TT_TEST_INACTIVE: '1', TT_TEST_PAGES: path.join(__dirname, 'pages') },
  });
  const page = await app.firstWindow();
  try {
    await page.waitForSelector('#lock:not([hidden])');
    await page.fill('#lock-pin', '1234');
    await page.fill('#lock-pin2', '1234');
    await page.click('#lock-submit');
    await page.waitForSelector('#lock', { state: 'hidden' });
    await page.click('#btn-cards');
    await page.waitForTimeout(300);
    await page.type('#c-number', '4242424242424242');
    await page.type('#c-exp', '1230');
    await page.type('#c-holder', 'TEST USER');
    await page.click('#c-add');
    await page.waitForSelector('.card-row', { timeout: 5000 });
    await page.keyboard.press('Escape');
    await page.click('#btn-new');
    await page.fill('#f-name', 'test');
    await page.click('.modal-foot .btn.primary');
    await page.waitForTimeout(3000);

    for (let i = 0; i < 4; i++) {
      const got = await app.evaluate(async ({ webContents }, u) => {
        const wc = webContents.getAllWebContents().find((w) => !/renderer\/index\.html/.test(w.getURL()));
        await wc.loadURL(u).catch(() => {});
        await new Promise((r) => setTimeout(r, 1200));
        return wc.getURL();
      }, topUrl);
      if (got === topUrl) break;
    }

    const proc = await app.evaluate(({ webContents }) => {
      const wc = webContents.getAllWebContents().find((w) => /shop\/d\.html/.test(w.getURL()));
      const f = wc.mainFrame.framesInSubtree.find((x) => /pay-d\.html/.test(x.url));
      return { top: wc.mainFrame.processId, frame: f ? f.processId : null };
    });
    check('payment frame runs in its own process', proc.frame && proc.frame !== proc.top, JSON.stringify(proc));

    await page.click('#tb-fill');
    await page.waitForTimeout(5000);
    const v = await app.evaluate(({ webContents }) => {
      const wc = webContents.getAllWebContents().find((w) => /shop\/d\.html/.test(w.getURL()));
      const f = wc.mainFrame.framesInSubtree.find((x) => /pay-d\.html/.test(x.url));
      return f.executeJavaScript(`({
        values: Object.fromEntries([...document.querySelectorAll('input')].map((e) => [e.name, e.value])),
        focused: document.activeElement && document.activeElement.name,
      })`);
    });
    check('D: card number', v.values.card_number === '4242 4242 4242 4242', v.values.card_number);
    check('D: expiry', v.values.expiration_date === '12/30', v.values.expiration_date);
    check('D: holder name', v.values.holder_name === 'TEST USER', v.values.holder_name);
    check('D: postal code untouched', v.values.billing_postal_code === '');
    check('D: CVV focused', v.focused === 'cvv', v.focused);
    const toast = (await page.$$eval('.toast .msg', (e) => e.map((x) => x.textContent))).pop() || '';
    check('D: message lists all three as filled', /رقم البطاقة/.test(toast) && !/لم تكتمل/.test(toast), toast.split('\n')[0]);
  } catch (err) {
    console.log('ERROR', err);
    failures += 1;
  } finally {
    await app.close();
    fs.rmSync(UD, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
