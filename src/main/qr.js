// Extracts the QR-login link of a TikTok login page.
// Primary: read TikTok's own passport API responses through the DevTools protocol.
// Fallback: decode the QR drawn on screen with jsQR.
const jsQR = require('jsqr');

const QR_API = /\/passport\/web\/(get_qrcode|check_qrconnect)\//;
const SCAN_INTERVAL_MS = 2500;
const RANK = { new: 0, scanned: 1, confirmed: 2 };

class QrWatcher {
  constructor(wc, { onChange, onExpired }) {
    this.wc = wc;
    this.onChange = onChange;
    this.onExpired = onExpired;
    this.url = null;
    this.status = null; // new | scanned | confirmed | expired
    this.source = null; // cdp | scan
    this.active = false;
    this.pending = new Map();
    this.timer = null;
    this.scanning = false;
    this.lastAlive = 0;
    this._onMessage = this._onMessage.bind(this);
  }

  attach() {
    try {
      this.wc.debugger.attach('1.3');
    } catch (err) {
      console.warn('debugger attach failed, using screen scan only', err.message);
      return;
    }
    this.wc.debugger.on('message', this._onMessage);
    this.wc.debugger.sendCommand('Network.enable').catch(() => {});
  }

  reset() {
    this.url = null;
    this.status = null;
    this.source = null;
    this.pending.clear();
  }

  setActive(active) {
    if (active === this.active) return;
    this.active = active;
    if (!active) this.reset();
    clearInterval(this.timer);
    this.timer = active ? setInterval(() => this._scanScreen(), SCAN_INTERVAL_MS) : null;
    this.onChange();
  }

  dispose() {
    clearInterval(this.timer);
    this.timer = null;
    this.active = false;
    try {
      if (!this.wc.isDestroyed() && this.wc.debugger.isAttached()) this.wc.debugger.detach();
    } catch { /* ignore */ }
  }

  _setUrl(url, source) {
    if (!/^https:\/\/([a-z0-9-]+\.)*tiktok\.com\//i.test(url)) return;
    if (url === this.url) return;
    // A link read from the API is authoritative; a screen scan never replaces it
    // with an older QR still visible on the page.
    if (source === 'scan' && this.source === 'cdp') return;
    this.url = url;
    this.source = source;
    this.status = 'new';
    this.lastAlive = Date.now();
    this.onChange();
  }

  // TikTok polls check_qrconnect on several regions at once (us / eu / sg); only
  // the account's home region knows about the scan, the others keep saying
  // "new". So a status only moves forward, and "expired" counts only when no
  // region has reported a live status for a while.
  _setStatus(status) {
    const now = Date.now();
    if (status === 'expired') {
      if (now - this.lastAlive < 5000 || this.status === 'expired') return;
    } else {
      this.lastAlive = now;
      if ((RANK[status] ?? -1) <= (RANK[this.status] ?? -1) && this.status !== 'expired') return;
    }
    this.status = status;
    this.onChange();
    if (status === 'expired') this.onExpired();
  }

  async _onMessage(_event, method, params) {
    if (!this.active) return;
    if (method === 'Network.responseReceived') {
      if (QR_API.test(params.response.url)) this.pending.set(params.requestId, params.response.url);
      return;
    }
    if (method !== 'Network.loadingFinished' || !this.pending.has(params.requestId)) return;

    const url = this.pending.get(params.requestId);
    this.pending.delete(params.requestId);
    try {
      const res = await this.wc.debugger.sendCommand('Network.getResponseBody', {
        requestId: params.requestId,
      });
      const text = res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body;
      const data = (JSON.parse(text) || {}).data || {};
      if (url.includes('get_qrcode') && data.qrcode_index_url) this._setUrl(data.qrcode_index_url, 'cdp');
      if (url.includes('check_qrconnect') && data.status) this._setStatus(String(data.status));
    } catch {
      // Body no longer available (page navigated) or not JSON: ignore.
    }
  }

  async _scanScreen() {
    if (!this.active || this.scanning || this.source === 'cdp' || this.wc.isDestroyed()) return;
    this.scanning = true;
    try {
      const image = await this.wc.capturePage();
      const bitmap = image.toBitmap(); // BGRA
      let { width, height } = image.getSize();
      if (!width || !height || !bitmap.length) return;
      if (bitmap.length !== width * height * 4) {
        const scale = Math.sqrt(bitmap.length / (4 * width * height));
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const rgba = new Uint8ClampedArray(bitmap.length);
      for (let i = 0; i < bitmap.length; i += 4) {
        rgba[i] = bitmap[i + 2];
        rgba[i + 1] = bitmap[i + 1];
        rgba[i + 2] = bitmap[i];
        rgba[i + 3] = 255;
      }
      const code = jsQR(rgba, width, height, { inversionAttempts: 'dontInvert' });
      if (code && code.data) this._setUrl(code.data.trim(), 'scan');
    } catch {
      // capture can fail while the view is hidden or navigating
    } finally {
      this.scanning = false;
    }
  }
}

module.exports = { QrWatcher };
