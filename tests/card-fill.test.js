// End-to-end test of the saved-card feature against local checkout pages.
// Uses a throwaway data folder and the published test card 4242 4242 4242 4242.
//   npm test
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-recharge-test-'));
const ELECTRON = require('electron'); // path to the electron binary

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
}

const readFrames = (app) => app.evaluate(({ webContents }) => {
  const wc = webContents.getAllWebContents().find((w) => /tests\/pages\//.test(w.getURL()));
  return Promise.all(wc.mainFrame.framesInSubtree.map((f) => f.executeJavaScript(`({
    page: location.pathname.split('/').pop(),
    focused: document.hasFocus() && document.activeElement && document.activeElement.tagName !== 'BODY'
      ? (document.activeElement.id || document.title) : null,
    values: Object.fromEntries([...document.querySelectorAll('input,select')].map((e) => [e.id || document.title, e.value])),
  })`)));
});

async function openPage(app, file) {
  const url = pathToFileURL(path.join(__dirname, 'pages', file)).href;
  for (let i = 0; i < 4; i++) {
    const got = await app.evaluate(async ({ webContents }, u) => {
      const wc = webContents.getAllWebContents().find((w) => !/renderer\/index\.html/.test(w.getURL()));
      await wc.loadURL(u).catch(() => {});
      await new Promise((r) => setTimeout(r, 800));
      return wc.getURL();
    }, url);
    if (got === url) return;
  }
  throw new Error(`could not open ${file}`);
}

(async () => {
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [ROOT],
    env: { ...process.env, TT_USER_DATA: UD, TT_FILL_ANY_HOST: '1' },
  });
  const page = await app.firstWindow();
  try {
    await page.waitForSelector('#lock:not([hidden])');
    await page.fill('#lock-pin', '1234');
    await page.fill('#lock-pin2', '1234');
    await page.click('#lock-submit');
    await page.waitForSelector('#lock', { state: 'hidden' });

    await page.click('#btn-cards');
    await page.type('#c-number', '4242424242424242');
    await page.type('#c-exp', '1230');
    await page.type('#c-holder', 'TEST USER');
    await page.click('#c-add');
    await page.waitForSelector('.card-row', { timeout: 5000 });
    check('card saved and shown masked', /•••• 4242/.test(await page.textContent('.card-row')));

    await page.type('#c-number', '4242424242424241');
    await page.type('#c-exp', '1230');
    await page.click('#c-add');
    await page.waitForTimeout(400);
    check('invalid card number rejected', (await page.$$('.card-row')).length === 1);
    await page.keyboard.press('Escape');

    const data = fs.readFileSync(path.join(UD, 'data.json'), 'utf8');
    check('card number not stored in plain text', !data.includes('4242424242424242'));

    await page.click('#btn-new');
    await page.fill('#f-name', 'test');
    await page.click('.modal-foot .btn.primary');
    await page.waitForTimeout(3000);

    // A: card number + CVV in separate iframes, auto-formatting expiry
    await openPage(app, 'a.html');
    await page.click('#tb-fill');
    await page.waitForTimeout(3500);
    let frames = await readFrames(app);
    const byPage = Object.fromEntries(frames.map((f) => [f.page, f]));
    check('A: number typed into iframe', byPage['num.html']?.values['Card number'] === '4242424242424242');
    check('A: expiry MM/YY', byPage['a.html']?.values.exp === '12/30');
    check('A: holder name', byPage['a.html']?.values.holder === 'TEST USER');
    check('A: CVV iframe focused', byPage['cvc.html']?.focused === 'Security code');

    // B: formatted number, month / year selects
    await openPage(app, 'b.html');
    await page.click('#tb-fill');
    await page.waitForTimeout(3500);
    frames = await readFrames(app);
    const b = frames.find((f) => f.page === 'b.html');
    check('B: formatted number', b.values.num === '4242 4242 4242 4242', b.values.num);
    check('B: month select', b.values.mm === '12');
    check('B: year select', b.values.yy === '2030');
    check('B: name', b.values.name === 'TEST USER');
    check('B: CVV focused', b.focused === 'cvv');
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
