// Fills a saved card into the payment form of a page, including card fields
// that live in payment-provider iframes (each frame is scanned separately).
// Values are typed as real keystrokes so formatted / framework-controlled
// inputs react exactly as if the operator typed them.

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs inside every frame: tags recognisable card fields and describes them.
const FRAME_SCAN = `(() => {
  const RX = {
    number: /cc-?number|card.?num|encryptedcardnumber|card no\\b|card #|رقم البطاقة|رقم الكرت|رقم الكارت/i,
    cvc: /cc-?csc|cvv|cvc|cvn|security.?code|card.?code|encryptedsecuritycode|رمز الأمان|الرمز السري|رمز التحقق/i,
    expMonth: /cc-?exp-?month|exp(iry|iration)?.?month|encryptedexpirymonth|شهر الانتهاء/i,
    expYear: /cc-?exp-?year|exp(iry|iration)?.?year|encryptedexpiryyear|سنة الانتهاء/i,
    exp: /cc-?exp|expir|exp.?date|valid.?thru|mm\\s*\\/\\s*yy|تاريخ الانتهاء|انتهاء الصلاحية|صالحة حتى|تاريخ الصلاحية/i,
    name: /cc-?name|card.?holder|holder.?name|name.?on.?card|اسم حامل|الاسم على البطاقة|اسم صاحب البطاقة/i,
  };
  const ORDER = ['number', 'cvc', 'expMonth', 'expYear', 'exp', 'name'];
  const SKIP = ['hidden', 'checkbox', 'radio', 'submit', 'button', 'image', 'file', 'email', 'search', 'range', 'color'];
  const visible = (el) => {
    if (el.disabled || el.readOnly) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const labelText = (el) => {
    let t = '';
    if (el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l) t += ' ' + l.innerText;
    }
    const pl = el.closest('label');
    if (pl) t += ' ' + pl.innerText;
    const lb = el.getAttribute('aria-labelledby');
    if (lb) lb.split(/\\s+/).forEach((id) => { const n = document.getElementById(id); if (n) t += ' ' + n.innerText; });
    return t;
  };
  const els = [...document.querySelectorAll('input, select')]
    .filter((el) => !SKIP.includes((el.type || '').toLowerCase()) && visible(el));
  const out = [];
  els.forEach((el) => {
    let text = [
      el.getAttribute('autocomplete'), el.name, el.id, el.placeholder,
      el.getAttribute('aria-label'), el.getAttribute('data-fieldtype'), el.getAttribute('data-testid'),
      el.getAttribute('data-elements-stable-field-name'), typeof el.className === 'string' ? el.className : '',
      labelText(el),
    ].filter(Boolean).join(' ');
    // A provider iframe often holds a single bare input: use the frame's own title / name / url.
    if (els.length === 1) text += ' ' + document.title + ' ' + window.name + ' ' + location.href;
    const kind = ORDER.find((k) => RX[k].test(text));
    if (!kind) return;
    const key = 'f' + Math.random().toString(36).slice(2, 10);
    el.setAttribute('data-ttfill', key);
    out.push({
      key, kind,
      tag: el.tagName.toLowerCase(),
      maxLength: el.maxLength > 0 ? el.maxLength : null,
      placeholder: el.placeholder || '',
    });
  });
  return out;
})()`;

const elExpr = (key) => `document.querySelector('[data-ttfill="${key}"]')`;

async function scan(wc) {
  const fields = [];
  for (const frame of wc.mainFrame.framesInSubtree) {
    if (!/^(https?|file):/.test(frame.url)) continue;
    try {
      const found = await frame.executeJavaScript(FRAME_SCAN);
      for (const f of found) fields.push({ ...f, frame });
    } catch {
      // frame navigated or not scriptable
    }
  }
  return fields;
}

function isFocused(field) {
  return field.frame.executeJavaScript(
    `document.hasFocus() && !!document.activeElement && document.activeElement.getAttribute('data-ttfill') === '${field.key}'`
  ).catch(() => false);
}

// Centre of the field in the page's coordinates, walking up through iframes.
async function pointFor(field) {
  let frame = field.frame;
  let pt = await frame.executeJavaScript(`(() => {
    const el = ${elExpr(field.key)}; if (!el) return null;
    const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`).catch(() => null);
  while (pt && frame.parent) {
    const child = frame;
    frame = frame.parent;
    const off = await frame.executeJavaScript(`(() => {
      const list = [...document.querySelectorAll('iframe, frame')];
      const name = ${JSON.stringify(child.name || '')};
      const url = ${JSON.stringify(child.url || '')};
      const strip = (u) => { try { const x = new URL(u, location.href); return x.origin + x.pathname; } catch { return ''; } };
      const el = (name && list.find((f) => f.name === name))
        || list.find((f) => f.src === url)
        || list.find((f) => strip(f.src) === strip(url))
        || (list.length === 1 ? list[0] : null);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + el.clientLeft, y: r.top + el.clientTop };
    })()`).catch(() => null);
    if (!off) return null;
    pt = { x: pt.x + off.x, y: pt.y + off.y };
  }
  return pt;
}

async function focusField(wc, field) {
  await field.frame.executeJavaScript(`(() => {
    const el = ${elExpr(field.key)}; if (!el) return;
    el.scrollIntoView({ block: 'center', inline: 'nearest' }); el.focus();
  })()`).catch(() => {});
  await delay(80);
  if (await isFocused(field)) return true;
  // Some providers only accept focus from a real click.
  const pt = await pointFor(field);
  if (!pt) return false;
  const x = Math.round(pt.x);
  const y = Math.round(pt.y);
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  await delay(150);
  return isFocused(field);
}

// Types into whatever element currently has focus in wc, key by key.
async function typeKeys(wc, text) {
  for (const ch of String(text)) {
    if (ch === ' ') {
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
      wc.sendInputEvent({ type: 'char', keyCode: ' ' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    } else {
      wc.sendInputEvent({ type: 'keyDown', keyCode: ch });
      wc.sendInputEvent({ type: 'char', keyCode: ch });
      wc.sendInputEvent({ type: 'keyUp', keyCode: ch });
    }
    await delay(18);
  }
}

function readValue(field) {
  return field.frame.executeJavaScript(`(${elExpr(field.key)} || {}).value || ''`).catch(() => '');
}

const digits = (s) => String(s).replace(/\D/g, '');

async function typeField(wc, field, text, expectDigits) {
  if (!(await focusField(wc, field))) return false;
  wc.selectAll();
  await delay(30);
  await typeKeys(wc, text);
  await delay(120);
  if (!expectDigits) return true;
  return digits(await readValue(field)) === expectDigits;
}

async function setSelect(field, candidates) {
  return field.frame.executeJavaScript(`(() => {
    const el = ${elExpr(field.key)}; if (!el) return false;
    const want = ${JSON.stringify(candidates)};
    const o = [...el.options].find((x) => want.includes(x.value.trim()) || want.includes(x.text.trim()));
    if (!o) return false;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, o.value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`).catch(() => false);
}

const pad2 = (n) => String(n).padStart(2, '0');

async function fillExpiry(wc, field, card) {
  const mm = pad2(card.month);
  const yy = pad2(card.year % 100);
  const yyyy = String(card.year);
  const long = /yyyy/i.test(field.placeholder) || field.maxLength === 7;
  const expect = long ? mm + yyyy : mm + yy;
  if (field.maxLength === 4) return typeField(wc, field, mm + yy, mm + yy);
  if (await typeField(wc, field, long ? `${mm}/${yyyy}` : `${mm}/${yy}`, expect)) return true;
  // auto-formatting fields that insert the slash themselves
  return typeField(wc, field, expect, expect);
}

async function fillPart(wc, field, kind, card) {
  if (field.tag === 'select') {
    if (kind === 'expMonth') return setSelect(field, [pad2(card.month), String(card.month)]);
    return setSelect(field, [String(card.year), pad2(card.year % 100)]);
  }
  if (kind === 'expMonth') return typeField(wc, field, pad2(card.month), pad2(card.month));
  const yy = pad2(card.year % 100);
  const yyyy = String(card.year);
  if (field.maxLength === 2 || /^yy$/i.test(field.placeholder.trim())) return typeField(wc, field, yy, yy);
  return (await typeField(wc, field, yyyy, yyyy)) || typeField(wc, field, yy, yy);
}

/**
 * Fill `card` into the first of `targets` (webContents) that shows a card form.
 * Returns { ok, filled: string[], failed: string[], cvcFocused }.
 */
async function fillCard(targets, card) {
  for (const wc of targets) {
    if (!wc || wc.isDestroyed()) continue;
    const fields = await scan(wc);
    const first = (k) => fields.find((f) => f.kind === k);
    const number = first('number');
    if (!number) continue;

    wc.focus();
    const filled = [];
    const failed = [];
    const mark = (ok, label) => (ok ? filled : failed).push(label);

    let ok = await typeField(wc, number, card.number, card.number);
    if (!ok) {
      // some fields want the number in groups of four
      ok = await typeField(wc, number, card.number.replace(/(\d{4})(?=\d)/g, '$1 '), card.number);
    }
    mark(ok, 'رقم البطاقة');

    const exp = first('exp');
    const month = first('expMonth');
    const year = first('expYear');
    if (exp) mark(await fillExpiry(wc, exp, card), 'تاريخ الانتهاء');
    else if (month || year) {
      if (month) mark(await fillPart(wc, month, 'expMonth', card), 'شهر الانتهاء');
      if (year) mark(await fillPart(wc, year, 'expYear', card), 'سنة الانتهاء');
    } else failed.push('تاريخ الانتهاء (لم يُعثر على الحقل)');

    const name = first('name');
    if (name && card.holder) mark(await typeField(wc, name, card.holder, null), 'اسم حامل البطاقة');

    const cvc = first('cvc');
    const cvcFocused = cvc ? await focusField(wc, cvc) : false;
    return { ok: true, filled, failed, cvcFocused };
  }
  return { ok: false, filled: [], failed: [], cvcFocused: false };
}

module.exports = { fillCard, typeKeys };
