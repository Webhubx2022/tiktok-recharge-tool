// The operator's own payment cards, encrypted with Windows DPAPI (safeStorage).
// Full card data never leaves the main process: the UI only sees a masked view.
// The security code (CVV) is deliberately not stored.
const { safeStorage } = require('electron');
const crypto = require('crypto');

function luhnOk(num) {
  let sum = 0;
  let dbl = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = num.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function brandOf(num) {
  if (/^4/.test(num)) return 'Visa';
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(num)) return 'Mastercard';
  if (/^3[47]/.test(num)) return 'Amex';
  if (/^(6011|65|64[4-9])/.test(num)) return 'Discover';
  if (/^35/.test(num)) return 'JCB';
  return 'Card';
}

function validate({ number, expiry, holder }) {
  const num = String(number || '').replace(/\D/g, '');
  if (num.length < 12 || num.length > 19 || !luhnOk(num)) throw new Error('رقم البطاقة غير صحيح');
  const m = String(expiry || '').replace(/\s/g, '').match(/^(\d{1,2})\/?(\d{2}|\d{4})$/);
  if (!m) throw new Error('تاريخ الانتهاء يجب أن يكون بالشكل MM/YY');
  const month = Number(m[1]);
  let year = Number(m[2]);
  if (year < 100) year += 2000;
  if (month < 1 || month > 12) throw new Error('شهر الانتهاء غير صحيح');
  const now = new Date();
  if (year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) {
    throw new Error('البطاقة منتهية الصلاحية');
  }
  return { number: num, month, year, holder: String(holder || '').trim().slice(0, 60) };
}

class Vault {
  constructor(store) {
    this.store = store;
    if (!Array.isArray(store.data.cards)) store.data.cards = [];
  }

  available() {
    return safeStorage.isEncryptionAvailable();
  }

  list() {
    const def = this.store.data.settings.defaultCardId;
    return this.store.data.cards.map((c) => ({
      id: c.id,
      label: c.label,
      brand: c.brand,
      last4: c.last4,
      expiry: c.expiry,
      isDefault: c.id === def,
    }));
  }

  add({ label, number, expiry, holder }) {
    if (!this.available()) throw new Error('التشفير غير متاح على هذا الجهاز — لا يمكن حفظ البطاقة');
    const card = validate({ number, expiry, holder });
    const id = crypto.randomBytes(6).toString('hex');
    const enc = safeStorage.encryptString(JSON.stringify(card)).toString('base64');
    const mm = String(card.month).padStart(2, '0');
    const yy = String(card.year % 100).padStart(2, '0');
    this.store.data.cards.push({
      id,
      label: String(label || '').trim().slice(0, 30) || brandOf(card.number),
      brand: brandOf(card.number),
      last4: card.number.slice(-4),
      expiry: `${mm}/${yy}`,
      enc,
    });
    if (!this.store.data.settings.defaultCardId) this.store.data.settings.defaultCardId = id;
    this.store.save();
    return id;
  }

  remove(id) {
    this.store.data.cards = this.store.data.cards.filter((c) => c.id !== id);
    if (this.store.data.settings.defaultCardId === id) {
      this.store.data.settings.defaultCardId = this.store.data.cards[0]?.id || null;
    }
    this.store.save();
  }

  setDefault(id) {
    if (!this.store.data.cards.some((c) => c.id === id)) throw new Error('البطاقة غير موجودة');
    this.store.data.settings.defaultCardId = id;
    this.store.save();
  }

  // Decrypted card for filling; returns null when there is none.
  get(id) {
    const wanted = id || this.store.data.settings.defaultCardId;
    const c = this.store.data.cards.find((x) => x.id === wanted) || this.store.data.cards[0];
    if (!c) return null;
    const data = JSON.parse(safeStorage.decryptString(Buffer.from(c.enc, 'base64')));
    return { ...data, label: c.label };
  }
}

module.exports = { Vault };
