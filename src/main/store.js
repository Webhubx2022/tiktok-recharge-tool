// Local JSON storage for customers, transactions, settings and the PIN hash.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_LINK_MESSAGE =
  'مرحباً {name} 👋\n' +
  'لإكمال شحن عملات تيك توك، افتح الرابط التالي من هاتفك (الجهاز المسجّل فيه حسابك) ووافق على تسجيل الدخول:\n' +
  '{link}\n\n' +
  '⏱️ الرابط صالح لدقائق قليلة فقط.';

const DEFAULT_DONE_MESSAGE =
  '✅ تم شحن {coins_text} لحسابك {username} بنجاح.\n' +
  'شكراً لتعاملك معنا 🌹';

function defaults() {
  return {
    version: 1,
    auth: { pinHash: null, salt: null },
    settings: {
      countryCode: '249',
      whatsappMode: 'web',
      linkMessage: DEFAULT_LINK_MESSAGE,
      doneMessage: DEFAULT_DONE_MESSAGE,
      defaultCardId: null,
    },
    customers: [],
    transactions: [],
    cards: [], // encrypted, see vault.js
    pendingCleanup: [],
  };
}

class Store {
  constructor(file) {
    this.file = file;
    this.data = this._load();
  }

  _load() {
    const base = defaults();
    if (!fs.existsSync(this.file)) return base;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        ...base,
        ...raw,
        auth: { ...base.auth, ...raw.auth },
        settings: { ...base.settings, ...raw.settings },
      };
    } catch (err) {
      // Never silently overwrite a damaged file: keep a copy for recovery.
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try { fs.copyFileSync(this.file, backup); } catch { /* ignore */ }
      console.error('data.json is damaged, backed up to', backup, err);
      return base;
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  // ---------- PIN ----------
  hasPin() {
    return !!this.data.auth.pinHash;
  }

  setPin(pin) {
    const salt = crypto.randomBytes(16).toString('hex');
    this.data.auth = { salt, pinHash: hashPin(pin, salt) };
    this.save();
  }

  checkPin(pin) {
    const { pinHash, salt } = this.data.auth;
    if (!pinHash) return false;
    const a = Buffer.from(hashPin(pin, salt), 'hex');
    const b = Buffer.from(pinHash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // ---------- settings ----------
  getSettings() {
    return { ...this.data.settings };
  }

  setSettings(patch) {
    const allowed = ['countryCode', 'whatsappMode', 'linkMessage', 'doneMessage'];
    for (const k of allowed) {
      if (patch[k] !== undefined) this.data.settings[k] = String(patch[k]);
    }
    this.save();
    return this.getSettings();
  }

  // ---------- customers ----------
  listCustomers() {
    return [...this.data.customers].sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
  }

  getCustomer(id) {
    return this.data.customers.find((c) => c.id === id) || null;
  }

  createCustomer({ name, phone, notes }) {
    const now = Date.now();
    const c = {
      id: crypto.randomBytes(6).toString('hex'),
      name: String(name || '').trim(),
      phone: String(phone || '').trim(),
      username: '',
      nickname: '',
      notes: String(notes || '').trim(),
      status: 'new',
      createdAt: now,
      lastUsedAt: now,
    };
    this.data.customers.push(c);
    this.save();
    return c;
  }

  updateCustomer(id, patch) {
    const c = this.getCustomer(id);
    if (!c) return null;
    const allowed = ['name', 'phone', 'username', 'nickname', 'notes', 'status', 'lastUsedAt'];
    for (const k of allowed) {
      if (patch[k] !== undefined) c[k] = typeof patch[k] === 'string' ? patch[k].trim() : patch[k];
    }
    this.save();
    return c;
  }

  deleteCustomer(id) {
    this.data.customers = this.data.customers.filter((c) => c.id !== id);
    if (!this.data.pendingCleanup.includes(id)) this.data.pendingCleanup.push(id);
    this.save();
  }

  takePendingCleanup() {
    const ids = this.data.pendingCleanup;
    this.data.pendingCleanup = [];
    if (ids.length) this.save();
    return ids;
  }

  // ---------- transactions ----------
  addTransaction(tx) {
    const record = {
      id: crypto.randomBytes(6).toString('hex'),
      at: Date.now(),
      kind: 'auto',
      coins: null,
      amount: null,
      ...tx,
    };
    this.data.transactions.unshift(record);
    this.save();
    return record;
  }

  getTransaction(id) {
    return this.data.transactions.find((t) => t.id === id) || null;
  }

  listTransactions() {
    return this.data.transactions;
  }
}

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}

module.exports = { Store };
