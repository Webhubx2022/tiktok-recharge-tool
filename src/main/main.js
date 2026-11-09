const {
  app, BrowserWindow, WebContentsView, ipcMain, clipboard, shell, Menu, nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('./store');
const sessions = require('./sessions');
const { QrWatcher } = require('./qr');
const capture = require('./capture');
const { Vault } = require('./vault');
const cardfill = require('./cardfill');

const LOGIN_URL = 'https://www.tiktok.com/login/qrcode';
const COIN_URL = 'https://www.tiktok.com/coin';
const TIKTOK_PRELOAD = path.join(__dirname, '../preload/tiktok.js');

app.userAgentFallback = sessions.CHROME_UA;
// Lets a test run use a throwaway data folder instead of the real one.
if (process.env.TT_USER_DATA) app.setPath('userData', process.env.TT_USER_DATA);

let win = null;
let store = null;
let vault = null;
const tabs = new Map(); // customerId -> tab
let activeId = null;
let overlay = false;
let locked = true;
let bounds = { x: 0, y: 0, width: 0, height: 0 };
let failedAttempts = 0;
let retryAt = 0;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(init);
}

function init() {
  store = new Store(path.join(app.getPath('userData'), 'data.json'));
  vault = new Vault(store);
  sessions.cleanupPartitions(store.takePendingCleanup());
  Menu.setApplicationMenu(null);

  win = new BrowserWindow({
    width: 1320,
    height: 800,
    minWidth: 1000,
    minHeight: 620,
    title: 'أداة شحن عملات تيك توك',
    backgroundColor: '#0f1117',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/ui.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => {
    // automated tests open the window without taking focus from the user's work
    if (process.env.TT_TEST_INACTIVE === '1') return win.showInactive();
    win.maximize();
    win.show();
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('before-input-event', (e, input) => handleShortcut(e, input));
  win.on('focus', () => win.flashFrame(false));

  registerIpc();

  let flushed = false;
  app.on('before-quit', (e) => {
    if (flushed) return;
    e.preventDefault();
    flushed = true;
    sessions.flushAll().finally(() => app.quit());
  });
  app.on('window-all-closed', () => app.quit());
}

// ---------------------------------------------------------------- helpers

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function toast(msg, type = 'info') {
  send('toast', { msg, type });
}

function emitCustomers() {
  send('customers', locked ? [] : store.listCustomers());
}

function canGoBack(wc) {
  if (wc.isDestroyed()) return false;
  return wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack();
}

function tabsState() {
  return {
    activeId,
    tabs: [...tabs.values()].map((t) => ({
      id: t.id,
      name: store.getCustomer(t.id)?.name || '',
      mode: t.mode,
      url: t.url,
      loading: t.loading,
      loggedIn: t.loggedIn,
      qrUrl: t.qr.url,
      qrStatus: t.qr.status,
      canGoBack: canGoBack(t.wc),
    })),
  };
}

function emitTabs() {
  send('tabs', locked ? { activeId: null, tabs: [] } : tabsState());
}

function layout() {
  for (const t of tabs.values()) {
    const show = !locked && !overlay && t.id === activeId;
    t.view.setVisible(show);
    if (show && bounds.width > 0 && bounds.height > 0) t.view.setBounds(bounds);
  }
}

function normalizePhone(raw) {
  const cc = String(store.getSettings().countryCode || '').replace(/\D/g, '');
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = cc + d.slice(1);
  else if (cc && d.length <= 9) d = cc + d;
  return d;
}

function fillTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

function openWhatsApp(phone, text) {
  const p = normalizePhone(phone);
  const t = encodeURIComponent(text);
  const url =
    store.getSettings().whatsappMode === 'app'
      ? `whatsapp://send?${p ? `phone=${p}&` : ''}text=${t}`
      : `https://wa.me/${p}?text=${t}`;
  return shell.openExternal(url);
}

function modeFor(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)tiktok\.com$/.test(u.hostname)) return 'other';
    if (u.pathname.startsWith('/login')) return 'login';
    if (u.pathname.startsWith('/coin')) return 'coin';
    return 'other';
  } catch {
    return 'other';
  }
}

// ---------------------------------------------------------------- tabs

async function openTab(id) {
  if (tabs.has(id)) return activateTab(id);
  const customer = store.getCustomer(id);
  if (!customer) throw new Error('العميل غير موجود');

  const ses = sessions.getSession(id);
  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      preload: TIKTOK_PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  view.setBackgroundColor('#ffffff');
  view.setVisible(false);
  win.contentView.addChildView(view);

  const wc = view.webContents;
  const tab = {
    id,
    view,
    wc,
    ses,
    mode: 'other',
    url: '',
    loading: true,
    loggedIn: false,
    lastPurchaseAt: 0,
    authTimer: null,
    popups: new Set(), // payment popups opened by the page
  };
  tab.qr = new QrWatcher(wc, {
    onChange: emitTabs,
    onExpired: () => {
      setTimeout(() => {
        if (!wc.isDestroyed() && tab.mode === 'login' && !tab.loggedIn) wc.loadURL(LOGIN_URL);
      }, 1500);
    },
  });
  tab.qr.attach();

  tab.onCookie = (_e, cookie) => {
    if (!sessions.isAuthCookie(cookie)) return;
    clearTimeout(tab.authTimer);
    tab.authTimer = setTimeout(() => checkAuth(tab), 800);
  };
  ses.cookies.on('changed', tab.onCookie);

  const onNav = (_e, url) => {
    tab.url = url;
    const mode = modeFor(url);
    if (mode === 'login' && tab.mode !== 'login') tab.qr.reset();
    tab.mode = mode;
    tab.qr.setActive(mode === 'login' && !tab.loggedIn);
    scheduleQrRetry(tab);
    emitTabs();
  };
  wc.on('did-navigate', onNav);
  wc.on('did-navigate-in-page', onNav);
  wc.on('did-start-loading', () => { tab.loading = true; emitTabs(); });
  wc.on('did-stop-loading', () => { tab.loading = false; emitTabs(); });
  wc.on('did-finish-load', () => {
    if (tab.loggedIn && !store.getCustomer(id)?.username) fetchAccountInfo(tab);
  });
  wc.on('before-input-event', (e, input) => handleShortcut(e, input, wc));
  wc.on('did-create-window', (child) => {
    tab.popups.add(child);
    child.webContents.on('before-input-event', (e, input) => handleShortcut(e, input, child.webContents));
    child.on('closed', () => tab.popups.delete(child));
  });
  wc.on('render-process-gone', (_e, details) => {
    toast(`الصفحة توقفت (${details.reason}) — جاري إعادة التحميل`, 'warn');
    setTimeout(() => !wc.isDestroyed() && wc.reload(), 1000);
  });
  // Payment providers (PayPal, 3-D Secure...) may open popups: keep them in the
  // customer's session, as a child of the main window.
  wc.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      parent: win,
      width: 520,
      height: 760,
      autoHideMenuBar: true,
      title: 'الدفع',
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    },
  }));

  tabs.set(id, tab);
  tab.loggedIn = await sessions.isLoggedIn(id).catch(() => false);
  store.updateCustomer(id, {
    lastUsedAt: Date.now(),
    status: tab.loggedIn ? 'active' : customer.status === 'new' ? 'new' : 'expired',
  });
  emitCustomers();
  activateTab(id);
  wc.loadURL(tab.loggedIn ? COIN_URL : LOGIN_URL);
  if (!tab.loggedIn && customer.status !== 'new') {
    toast(`جلسة ${customer.name} انتهت — أرسل له رابط دخول جديد`, 'warn');
  }
}

// TikTok's QR sometimes stays on its loading spinner; reload if no link shows up.
function scheduleQrRetry(tab) {
  clearTimeout(tab.qrRetryTimer);
  if (tab.mode !== 'login' || tab.loggedIn) {
    tab.qrRetries = 0;
    return;
  }
  tab.qrRetryTimer = setTimeout(() => {
    if (tab.wc.isDestroyed() || tab.mode !== 'login' || tab.loggedIn || tab.qr.url) return;
    if ((tab.qrRetries || 0) >= 2) {
      toast('رمز QR لا يظهر — تأكد من الإنترنت ثم اضغط «⟳ رمز جديد»', 'warn');
      return;
    }
    tab.qrRetries = (tab.qrRetries || 0) + 1;
    tab.wc.reload();
  }, 20000);
}

function activateTab(id) {
  if (!tabs.has(id)) return;
  activeId = id;
  layout();
  emitTabs();
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  tab.qr.dispose();
  clearTimeout(tab.authTimer);
  clearTimeout(tab.qrRetryTimer);
  tab.ses.cookies.removeListener('changed', tab.onCookie);
  tab.ses.cookies.flushStore().catch(() => {});
  for (const p of tab.popups) if (!p.isDestroyed()) p.close();
  win.contentView.removeChildView(tab.view);
  if (!tab.wc.isDestroyed()) tab.wc.close();
  tabs.delete(id);
  if (activeId === id) activeId = [...tabs.keys()].pop() || null;
  layout();
  emitTabs();
}

async function checkAuth(tab) {
  if (tab.wc.isDestroyed()) return;
  const logged = await sessions.isLoggedIn(tab.id).catch(() => false);
  const customer = store.getCustomer(tab.id);
  if (!customer || logged === tab.loggedIn) return;
  tab.loggedIn = logged;
  if (logged) {
    tab.qr.setActive(false);
    store.updateCustomer(tab.id, { status: 'active', lastUsedAt: Date.now() });
    toast(`✅ تم تسجيل دخول حساب ${customer.name}`, 'ok');
    if (tab.mode !== 'coin') tab.wc.loadURL(COIN_URL);
  } else {
    store.updateCustomer(tab.id, { status: 'expired' });
    toast(`⚠️ خرج حساب ${customer.name} — يحتاج تسجيل دخول جديد`, 'warn');
    if (tab.mode !== 'login') tab.wc.loadURL(LOGIN_URL);
  }
  emitCustomers();
  emitTabs();
}

async function fetchAccountInfo(tab) {
  try {
    const info = await tab.wc.executeJavaScript(
      `fetch('https://www.tiktok.com/passport/web/account/info/?aid=1459', { credentials: 'include' })
         .then((r) => r.json()).catch(() => null)`,
      true
    );
    const d = info && info.data;
    if (d && d.username) {
      store.updateCustomer(tab.id, { username: d.username, nickname: d.screen_name || d.name || '' });
      emitCustomers();
    }
  } catch {
    // best effort; the username can also be typed in the customer form
  }
}

async function refreshStatuses() {
  for (const c of store.listCustomers()) {
    if (c.status === 'new' || tabs.has(c.id)) continue;
    const ok = await sessions.isLoggedIn(c.id).catch(() => false);
    const status = ok ? 'active' : 'expired';
    if (status !== c.status) store.updateCustomer(c.id, { status });
  }
  emitCustomers();
}

async function relogin(id) {
  const tab = tabs.get(id);
  await sessions.clearSession(id);
  store.updateCustomer(id, { status: 'expired', username: '', nickname: '' });
  if (tab) {
    tab.loggedIn = false;
    tab.qr.reset();
    tab.wc.loadURL(LOGIN_URL);
  } else {
    await openTab(id);
  }
  emitCustomers();
  emitTabs();
}

async function removeCustomer(id) {
  closeTab(id);
  await sessions.clearSession(id).catch(() => {});
  store.deleteCustomer(id);
  emitCustomers();
}

// ---------------------------------------------------------------- receipts

async function takeReceipt(tab, { coins = null, amount = null, kind = 'auto' } = {}) {
  if (activeId !== tab.id) activateTab(tab.id);
  const customer = store.getCustomer(tab.id);
  let shot;
  try {
    shot = await capture.captureReceipt(tab.wc, customer, coins ? `${coins}coins` : kind === 'manual' ? 'manual' : '');
  } catch (err) {
    toast('تعذّر أخذ لقطة الشاشة — جرّب زر 📸 مرة أخرى', 'err');
    return null;
  }
  clipboard.writeImage(shot.image);
  const tx = store.addTransaction({
    kind,
    customerId: tab.id,
    customerName: customer?.name || '',
    username: customer?.username || '',
    coins,
    amount,
    file: shot.file,
  });
  send('purchase', tx);
  if (!win.isFocused()) win.flashFrame(true);
  return tx;
}

async function handlePurchase(tab, info) {
  const now = Date.now();
  if (now - tab.lastPurchaseAt < 8000) return;
  tab.lastPurchaseAt = now;
  await delay(900); // let the success dialog finish animating
  if (tab.wc.isDestroyed()) return;
  await takeReceipt(tab, { coins: info.coins || null, amount: info.amount || null, kind: 'auto' });
}

function doneMessage(tx) {
  const c = store.getCustomer(tx.customerId);
  const username = c?.username || tx.username;
  return fillTemplate(store.getSettings().doneMessage, {
    name: c?.name || tx.customerName || '',
    username: username ? `@${username}` : '',
    coins: tx.coins ?? '',
    coins_text: tx.coins ? `${tx.coins.toLocaleString('en-US')} عملة` : 'العملات',
    amount: tx.amount || '',
  });
}

function copyTxImage(tx) {
  const img = nativeImage.createFromPath(tx.file);
  if (img.isEmpty()) throw new Error('ملف الصورة غير موجود');
  clipboard.writeImage(img);
}

// ---------------------------------------------------------------- saved card

// Card data is only typed into TikTok pages or the payment popups they opened.
function fillAllowed(tab, wc) {
  if (process.env.TT_FILL_ANY_HOST === '1') return true;
  if ([...tab.popups].some((p) => !p.isDestroyed() && p.webContents === wc)) {
    return /^https:/.test(wc.getURL());
  }
  try {
    const u = new URL(wc.getURL());
    return u.protocol === 'https:' && /(^|\.)tiktok\.com$/.test(u.hostname);
  } catch {
    return false;
  }
}

function tabOfWc(wc) {
  return [...tabs.values()].find(
    (t) => t.wc === wc || [...t.popups].some((p) => !p.isDestroyed() && p.webContents === wc)
  );
}

let filling = false;
async function fillCardIn(tab, cardId, preferredWc) {
  if (filling) return null;
  let card;
  try {
    card = vault.get(cardId);
  } catch {
    toast('تعذّر فك تشفير البطاقة — احذفها وأضفها من جديد', 'err');
    return null;
  }
  if (!card) {
    toast('لا توجد بطاقة محفوظة — أضف بطاقتك من «💳 البطاقات»', 'warn');
    return null;
  }
  const popups = [...tab.popups].filter((p) => !p.isDestroyed()).map((p) => p.webContents);
  const targets = [preferredWc, ...popups, tab.wc]
    .filter((wc, i, a) => wc && !wc.isDestroyed() && a.indexOf(wc) === i && tabOfWc(wc) === tab && fillAllowed(tab, wc));
  filling = true;
  try {
    const res = await cardfill.fillCard(targets, card);
    const reportFile = res.ok && !res.failed.length ? null : await saveFillReport(res);
    const reportHint = reportFile ? `\n📄 وصف الخانات (بدون أي بيانات) حُفظ في: ${reportFile} — أرسله للمطوّر لإصلاح التعرّف` : '';
    if (!res.ok) {
      toast(`لم أجد نموذج البطاقة في الصفحة — اضغط «الشحن» أولاً حتى تظهر خانات البطاقة، أو اضغط داخل الخانة واستخدم Alt+1 / Alt+2 / Alt+3${reportHint}`, 'warn');
    } else {
      const parts = [];
      if (res.filled.length) parts.push(`✅ تمت تعبئة: ${res.filled.join('، ')}`);
      if (res.failed.length) parts.push(`⚠️ لم تكتمل: ${res.failed.join('، ')} (اضغط في الخانة ثم Alt+1 رقم / Alt+2 تاريخ / Alt+3 اسم)`);
      parts.push(res.cvcFocused ? '⌨️ اكتب رمز CVV الآن' : '⌨️ اكتب رمز CVV');
      toast(parts.join('\n') + reportHint, res.failed.length ? 'warn' : 'ok');
    }
    return { ok: res.ok, filled: res.filled, failed: res.failed, cvcFocused: res.cvcFocused };
  } finally {
    filling = false;
  }
}

// Value-free description of the payment form, to fix field recognition later.
async function saveFillReport(res) {
  try {
    const file = path.join(app.getPath('documents'), 'TT Recharge', 'fill-report.json');
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const body = {
      app: app.getVersion(),
      at: new Date().toISOString(),
      filled: res.filled,
      failed: res.failed,
      frames: res.report,
    };
    await fs.promises.writeFile(file, JSON.stringify(body, null, 2), 'utf8');
    return file;
  } catch {
    return null;
  }
}

async function typeCardPart(wc, which) {
  const tab = tabOfWc(wc);
  if (!tab || !fillAllowed(tab, wc)) return;
  let card;
  try {
    card = vault.get();
  } catch {
    card = null;
  }
  if (!card) {
    toast('لا توجد بطاقة محفوظة', 'warn');
    return;
  }
  const text = which === '1'
    ? card.number
    : which === '2'
      ? `${String(card.month).padStart(2, '0')}/${String(card.year % 100).padStart(2, '0')}`
      : card.holder;
  if (!text) return;
  wc.selectAll();
  await cardfill.typeKeys(wc, text);
}

// ---------------------------------------------------------------- shortcuts

function handleShortcut(event, input, sourceWc = null) {
  if (input.type !== 'keyDown' || locked) return;
  const tab = tabs.get(activeId);
  if (input.key === 'F3' && tab) {
    event.preventDefault();
    fillCardIn(tab, null, sourceWc);
  } else if (input.alt && !input.control && ['1', '2', '3'].includes(input.key) && sourceWc) {
    // type one value of the default card into the field the operator clicked
    event.preventDefault();
    typeCardPart(sourceWc, input.key);
  } else if (input.key === 'F2' && tab) {
    event.preventDefault();
    takeReceipt(tab, { kind: 'manual' });
  } else if (input.key === 'F5' && tab) {
    event.preventDefault();
    tab.wc.reload();
  } else if (input.alt && input.key === 'ArrowLeft' && tab && canGoBack(tab.wc)) {
    event.preventDefault();
    tab.wc.navigationHistory ? tab.wc.navigationHistory.goBack() : tab.wc.goBack();
  } else if (input.control && input.shift && input.key.toLowerCase() === 'i' && tab) {
    event.preventDefault();
    tab.wc.openDevTools({ mode: 'detach' });
  }
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  const guarded = (fn) => async (_e, ...args) => {
    if (locked) throw new Error('التطبيق مقفول');
    return fn(...args);
  };
  const handle = (ch, fn) => ipcMain.handle(ch, guarded(fn));
  const tabOf = (id) => {
    const t = tabs.get(id || activeId);
    if (!t) throw new Error('لا يوجد عميل مفتوح');
    return t;
  };

  // --- auth (not guarded) ---
  ipcMain.handle('auth:state', () => ({ hasPin: store.hasPin(), locked }));
  ipcMain.handle('auth:setup', (_e, pin) => {
    if (store.hasPin()) throw new Error('رمز PIN موجود مسبقاً');
    if (!/^\d{4,8}$/.test(String(pin))) throw new Error('رمز PIN يجب أن يكون من 4 إلى 8 أرقام');
    store.setPin(String(pin));
    unlock();
    return { ok: true };
  });
  ipcMain.handle('auth:unlock', (_e, pin) => {
    const wait = Math.ceil((retryAt - Date.now()) / 1000);
    if (wait > 0) return { ok: false, wait };
    if (!store.checkPin(String(pin))) {
      failedAttempts += 1;
      if (failedAttempts >= 5) retryAt = Date.now() + 30000 * (failedAttempts - 4);
      return { ok: false, wait: Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)) };
    }
    failedAttempts = 0;
    retryAt = 0;
    unlock();
    return { ok: true };
  });
  ipcMain.handle('auth:lock', () => {
    locked = true;
    layout();
    emitTabs();
    emitCustomers();
    send('locked', true);
    return { ok: true };
  });
  handle('auth:change', ({ oldPin, newPin }) => {
    if (!store.checkPin(String(oldPin))) throw new Error('رمز PIN الحالي غير صحيح');
    if (!/^\d{4,8}$/.test(String(newPin))) throw new Error('رمز PIN الجديد يجب أن يكون من 4 إلى 8 أرقام');
    store.setPin(String(newPin));
    return { ok: true };
  });

  // --- customers ---
  handle('customers:list', () => store.listCustomers());
  handle('customers:create', (data) => {
    if (!String(data?.name || '').trim()) throw new Error('اسم العميل مطلوب');
    const c = store.createCustomer(data);
    emitCustomers();
    return c;
  });
  handle('customers:update', (id, patch) => {
    if (patch.name !== undefined && !String(patch.name).trim()) throw new Error('اسم العميل مطلوب');
    const { name, phone, username, notes } = patch;
    const c = store.updateCustomer(id, {
      name, phone, notes,
      username: username !== undefined ? String(username).replace(/^@/, '') : undefined,
    });
    emitCustomers();
    emitTabs();
    return c;
  });
  handle('customers:remove', (id) => removeCustomer(id));

  // --- tabs / view ---
  handle('tabs:open', (id) => openTab(id));
  handle('tabs:close', (id) => closeTab(id));
  handle('tabs:activate', (id) => activateTab(id));
  handle('tabs:state', () => tabsState());
  ipcMain.handle('view:overlay', (_e, on) => {
    overlay = !!on;
    layout();
  });
  ipcMain.on('view:bounds', (_e, rect) => {
    bounds = {
      x: Math.max(0, Math.round(rect.x)),
      y: Math.max(0, Math.round(rect.y)),
      width: Math.max(0, Math.round(rect.width)),
      height: Math.max(0, Math.round(rect.height)),
    };
    layout();
  });
  handle('view:nav', (action, id) => {
    const t = tabOf(id);
    if (action === 'coin') t.wc.loadURL(COIN_URL);
    else if (action === 'login') t.wc.loadURL(LOGIN_URL);
    else if (action === 'reload') t.wc.reload();
    else if (action === 'back' && canGoBack(t.wc)) {
      t.wc.navigationHistory ? t.wc.navigationHistory.goBack() : t.wc.goBack();
    }
  });

  // --- QR link ---
  handle('qr:copy', (id) => {
    const t = tabOf(id);
    if (!t.qr.url) throw new Error('رابط الدخول لم يجهز بعد');
    clipboard.writeText(t.qr.url);
    return t.qr.url;
  });
  handle('qr:whatsapp', async (id) => {
    const t = tabOf(id);
    if (!t.qr.url) throw new Error('رابط الدخول لم يجهز بعد');
    const c = store.getCustomer(t.id);
    clipboard.writeText(t.qr.url);
    await openWhatsApp(c?.phone, fillTemplate(store.getSettings().linkMessage, {
      name: c?.name || '',
      link: t.qr.url,
    }));
  });
  handle('qr:relogin', (id) => relogin(id));

  // --- receipts / transactions ---
  ipcMain.on('tt:purchase', (e, info) => {
    if (locked) return;
    const tab = [...tabs.values()].find((t) => !t.wc.isDestroyed() && t.wc.id === e.sender.id);
    if (tab) handlePurchase(tab, info || {});
  });
  handle('capture:now', (id) => takeReceipt(tabOf(id), { kind: 'manual' }));
  handle('tx:list', () => store.listTransactions());
  handle('tx:copy', (txId) => {
    const tx = store.getTransaction(txId);
    if (!tx) throw new Error('العملية غير موجودة');
    copyTxImage(tx);
  });
  handle('tx:open', async (txId) => {
    const tx = store.getTransaction(txId);
    if (!tx || !fs.existsSync(tx.file)) throw new Error('ملف الصورة غير موجود');
    const err = await shell.openPath(tx.file);
    if (err) throw new Error(err);
  });
  handle('tx:whatsapp', async (txId) => {
    const tx = store.getTransaction(txId);
    if (!tx) throw new Error('العملية غير موجودة');
    copyTxImage(tx);
    const c = store.getCustomer(tx.customerId);
    await openWhatsApp(c?.phone, doneMessage(tx));
  });
  handle('receipts:folder', async (customerId) => {
    const c = customerId ? store.getCustomer(customerId) : null;
    const dir = c ? capture.customerDir(c) : capture.receiptsRoot();
    await fs.promises.mkdir(dir, { recursive: true });
    await shell.openPath(dir);
  });

  // --- saved cards (the UI only ever sees masked data) ---
  handle('cards:list', () => ({ cards: vault.list(), available: vault.available() }));
  handle('cards:add', (data) => {
    vault.add(data || {});
    return vault.list();
  });
  handle('cards:remove', (id) => {
    vault.remove(id);
    return vault.list();
  });
  handle('cards:default', (id) => {
    vault.setDefault(id);
    return vault.list();
  });
  handle('cards:fill', (cardId) => fillCardIn(tabOf(), cardId || null, null));

  // --- settings ---
  handle('settings:get', () => store.getSettings());
  handle('settings:set', (patch) => store.setSettings(patch || {}));
}

function unlock() {
  locked = false;
  layout();
  emitCustomers();
  emitTabs();
  refreshStatuses();
}
