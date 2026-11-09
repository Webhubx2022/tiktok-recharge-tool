// One persistent, isolated browser session (cookie jar) per customer.
const { app, session, protocol, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// Tests only (TT_TEST_PAGES=<folder>): serve that folder as tttest://<host>/<file>
// so a test page and its payment frame can be two different sites (tttest://shop
// and tttest://pay), each in its own process like tiktok.com and its payment
// provider, without any network server. Off unless the variable is set.
const TEST_PAGES = process.env.TT_TEST_PAGES || '';
if (TEST_PAGES) {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'tttest', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}
function serveTestPages(ses) {
  ses.protocol.handle('tttest', (req) => {
    const file = path.join(TEST_PAGES, path.basename(new URL(req.url).pathname));
    return net.fetch(pathToFileURL(file).href);
  });
}

const CHROME_MAJOR = process.versions.chrome.split('.')[0];
const CHROME_UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

// Cookies TikTok sets once an account is signed in.
const AUTH_COOKIES = ['sessionid', 'sessionid_ss', 'sid_tt'];

const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);
const configured = new Set();

function partitionName(id) {
  return `cust_${id}`;
}

function getSession(id) {
  const ses = session.fromPartition(`persist:${partitionName(id)}`);
  if (!configured.has(id)) {
    configured.add(id);
    ses.setUserAgent(CHROME_UA, 'ar,en-US;q=0.9,en;q=0.8');
    ses.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(ALLOWED_PERMISSIONS.has(permission));
    });
    if (TEST_PAGES) serveTestPages(ses);
  }
  return ses;
}

async function isLoggedIn(id) {
  const cookies = await getSession(id).cookies.get({ domain: 'tiktok.com' });
  const now = Date.now() / 1000;
  return cookies.some(
    (c) => AUTH_COOKIES.includes(c.name) && c.value && (!c.expirationDate || c.expirationDate > now)
  );
}

function isAuthCookie(cookie) {
  return AUTH_COOKIES.includes(cookie.name) && /tiktok\.com$/.test(cookie.domain.replace(/^\./, ''));
}

async function clearSession(id) {
  const ses = getSession(id);
  await ses.clearStorageData();
  await ses.clearCache();
  await ses.cookies.flushStore();
}

function partitionDir(id) {
  return path.join(app.getPath('userData'), 'Partitions', partitionName(id));
}

// Folders of deleted customers are removed on the next start, before any
// session has them open.
function cleanupPartitions(ids) {
  for (const id of ids) {
    try {
      fs.rmSync(partitionDir(id), { recursive: true, force: true });
    } catch (err) {
      console.error('could not remove partition', id, err);
    }
  }
}

async function flushAll() {
  await Promise.all([...configured].map((id) => getSession(id).cookies.flushStore().catch(() => {})));
}

module.exports = {
  CHROME_UA,
  getSession,
  isLoggedIn,
  isAuthCookie,
  clearSession,
  cleanupPartitions,
  flushAll,
};
