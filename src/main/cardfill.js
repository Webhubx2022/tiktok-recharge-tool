// Fills a saved card into the payment form of a page, including card fields
// that live in payment-provider iframes (each frame is scanned separately).
// Values are typed as real keystrokes so formatted / framework-controlled
// inputs react exactly as if the operator typed them.

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs inside every frame: tags recognisable card fields and describes them.
// It also returns a value-free description of every field (`all`), saved for
// diagnosis when a form is not recognised.
//
// What a field is comes from, in order: its attributes, its <label>, the text
// written next to it in its own container (TikTok's form puts "Card number"
// in a plain div above the input), and its placeholder ("1234 3213 2313 3213").
// Inputs inside open shadow roots are included.
const FRAME_SCAN = `(() => {
  const RX = {
    number: /cc-?number|card.?num|encryptedcardnumber|card no\\b|card #|رقم البطاقة|رقم الكرت|رقم الكارت|numéro de carte|número de tarjeta/i,
    cvc: /cc-?csc|cvv|cvc|cvn|security.?code|card.?code|encryptedsecuritycode|رمز الأمان|الرمز السري|رمز التحقق/i,
    expMonth: /cc-?exp-?month|exp(iry|iration)?.?month|encryptedexpirymonth|شهر الانتهاء/i,
    expYear: /cc-?exp-?year|exp(iry|iration)?.?year|encryptedexpiryyear|سنة الانتهاء/i,
    exp: /cc-?exp|expir|exp.?date|valid.?thru|mm\\s*\\/\\s*yy|تاريخ الانتهاء|انتهاء الصلاحية|صالحة حتى|تاريخ الصلاحية/i,
    name: /cc-?name|card.?holder|holder.?name|name.?on.?card|اسم حامل|الاسم على البطاقة|اسم صاحب البطاقة/i,
    postal: /postal|zip|post.?code|الرمز البريدي/i,
  };
  const ORDER = ['number', 'cvc', 'expMonth', 'expYear', 'exp', 'name', 'postal'];
  const SKIP = ['hidden', 'checkbox', 'radio', 'submit', 'button', 'image', 'file', 'email', 'search', 'range', 'color'];
  const deepInputs = (root, acc = []) => {
    root.querySelectorAll('input, select').forEach((el) => acc.push(el));
    root.querySelectorAll('*').forEach((n) => { if (n.shadowRoot) deepInputs(n.shadowRoot, acc); });
    return acc;
  };
  const visible = (el) => {
    if (el.disabled) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const labelText = (el) => {
    const root = el.getRootNode();
    let t = '';
    if (el.id && root.querySelector) {
      const l = root.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l) t += ' ' + l.innerText;
    }
    const pl = el.closest('label');
    if (pl) t += ' ' + pl.innerText;
    const lb = el.getAttribute('aria-labelledby');
    if (lb && root.getElementById) lb.split(/\\s+/).forEach((id) => { const n = root.getElementById(id); if (n) t += ' ' + n.innerText; });
    return t;
  };
  // text of the smallest container that holds this input and no other one
  const nearText = (el) => {
    let n = el;
    for (let i = 0; i < 4 && n.parentElement; i++) {
      n = n.parentElement;
      if (n.querySelectorAll('input, select').length > 1) break;
      const t = (n.innerText || '').trim();
      if (t) return t.slice(0, 80);
    }
    return '';
  };
  const els = deepInputs(document).filter((el) => !SKIP.includes((el.type || '').toLowerCase()) && visible(el));
  const out = [];
  const all = [];
  els.forEach((el) => {
    const near = nearText(el);
    let text = [
      el.getAttribute('autocomplete'), el.name, el.id, el.placeholder,
      el.getAttribute('aria-label'), el.getAttribute('data-fieldtype'), el.getAttribute('data-testid'),
      el.getAttribute('data-elements-stable-field-name'), typeof el.className === 'string' ? el.className : '',
      labelText(el), near,
    ].filter(Boolean).join(' ');
    if (/^\\s*\\d{4}[\\s-]+\\d{4}[\\s-]+\\d{4}/.test(el.placeholder || '')) text += ' card-number';
    // A provider iframe often holds a single bare input: use the frame's own title / name / url.
    if (els.length === 1) text += ' ' + document.title + ' ' + window.name + ' ' + location.href;
    const kind = ORDER.find((k) => RX[k].test(text)) || null;
    all.push({
      kind,
      tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '', id: el.id || '',
      placeholder: el.placeholder || '', autocomplete: el.getAttribute('autocomplete') || '',
      ariaLabel: el.getAttribute('aria-label') || '', maxLength: el.maxLength > 0 ? el.maxLength : null,
      readOnly: !!el.readOnly, inShadow: el.getRootNode() !== document, near,
    });
    if (!kind || kind === 'postal') return;
    const key = 'f' + Math.random().toString(36).slice(2, 10);
    el.setAttribute('data-ttfill', key);
    out.push({
      key, kind,
      tag: el.tagName.toLowerCase(),
      maxLength: el.maxLength > 0 ? el.maxLength : null,
      placeholder: el.placeholder || '',
    });
  });
  return { fields: out, all };
})()`;

// Finds a tagged field, also inside open shadow roots.
const elExpr = (key) => `((k) => {
  const walk = (root) => {
    const hit = root.querySelector('[data-ttfill="' + k + '"]');
    if (hit) return hit;
    for (const n of root.querySelectorAll('*')) if (n.shadowRoot) { const r = walk(n.shadowRoot); if (r) return r; }
    return null;
  };
  return walk(document);
})(${JSON.stringify(key)})`;

// Scans every frame; `report` describes all fields found (no values).
async function scan(wc) {
  const fields = [];
  const report = [];
  for (const frame of wc.mainFrame.framesInSubtree) {
    if (!/^(https?|file):/.test(frame.url)) continue;
    try {
      const res = await frame.executeJavaScript(FRAME_SCAN);
      for (const f of res.fields) fields.push({ ...f, frame });
      let origin = frame.url;
      try { origin = new URL(frame.url).origin; } catch { /* keep */ }
      if (res.all.length) report.push({ frame: origin, fields: res.all });
    } catch {
      // frame navigated or not scriptable
    }
  }
  return { fields, report };
}

// When the window itself is not in front, document.hasFocus() is false in every
// frame, so only the element focus inside the frame can be checked.
function isFocused(wc, field) {
  const strict = wc.isFocused();
  return field.frame.executeJavaScript(`(() => {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return (${strict} ? document.hasFocus() : true) && !!a && a.getAttribute('data-ttfill') === ${JSON.stringify(field.key)};
  })()`).catch(() => false);
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

// Focus a field so that keystrokes reach it.
// A payment provider's iframe (e.g. pay-my.pipopay.com inside tiktok.com) runs
// in its own process: el.focus() from script moves the caret there, but the
// browser keeps sending keys to the top page. A real mouse click at the field
// makes the browser hand the keyboard to that frame, so a click comes first.
async function focusField(wc, field) {
  if (await focusOnce(wc, field)) return true;
  await delay(250);
  if (!wc.isFocused()) wc.focus();
  return focusOnce(wc, field);
}

async function focusOnce(wc, field) {
  await field.frame.executeJavaScript(`(() => {
    const el = ${elExpr(field.key)}; if (el) el.scrollIntoView({ block: 'center', inline: 'nearest' });
  })()`).catch(() => {});
  await delay(60);
  const pt = await pointFor(field);
  if (pt) {
    const x = Math.round(pt.x);
    const y = Math.round(pt.y);
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await delay(150);
    if (await isFocused(wc, field)) return true;
  }
  await field.frame.executeJavaScript(`(() => { const el = ${elExpr(field.key)}; if (el) el.focus(); })()`).catch(() => {});
  await delay(80);
  return isFocused(wc, field);
}

// Last resort: write the value from inside the field's own frame, the way
// framework-controlled inputs (React, Vue, input masks) expect it.
function setValueInFrame(field, text) {
  return field.frame.executeJavaScript(`(() => {
    const el = ${elExpr(field.key)}; if (!el) return false;
    const v = ${JSON.stringify(text)};
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: v }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('blur'));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    return true;
  })()`).catch(() => false);
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
const sameText = (a, b) => String(a).replace(/\s+/g, ' ').trim().toUpperCase() === String(b).replace(/\s+/g, ' ').trim().toUpperCase();

/**
 * Put `text` into `field` and confirm it by reading the value back.
 * `expectDigits` set: the field must hold exactly those digits (formatting ignored).
 * `expectDigits` null: the field must hold `text` (case and spacing ignored).
 * Keystrokes first; if the value is not right, write it from inside the frame.
 */
async function typeField(wc, field, text, expectDigits) {
  const ok = (v) => (expectDigits ? digits(v) === expectDigits : sameText(v, text));
  if (await focusField(wc, field)) {
    wc.selectAll();
    await delay(30);
    await typeKeys(wc, text);
    await delay(150);
    if (ok(await readValue(field))) return true;
  }
  await setValueInFrame(field, text);
  await delay(150);
  return ok(await readValue(field));
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
  return typeField(wc, field, long ? `${mm}/${yyyy}` : `${mm}/${yy}`, expect);
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
 * Fill `card` into the target (webContents) that shows the most card fields.
 * A form is filled even when one field is not recognised; the others still go in.
 * Returns { ok, filled: string[], failed: string[], cvcFocused, report }, where
 * `report` describes every field seen in every target (no values).
 */
async function fillCard(targets, card) {
  let best = null;
  const report = [];
  for (const wc of targets) {
    if (!wc || wc.isDestroyed()) continue;
    const res = await scan(wc);
    report.push(...res.report);
    if (res.fields.length && (!best || res.fields.length > best.fields.length)) best = { wc, fields: res.fields };
  }
  if (!best) return { ok: false, filled: [], failed: [], cvcFocused: false, report };

  const { wc, fields } = best;
  const first = (k) => fields.find((f) => f.kind === k);
  wc.focus();
  const filled = [];
  const failed = [];
  const mark = (ok, label) => (ok ? filled : failed).push(label);

  const number = first('number');
  if (number) {
    mark(await typeField(wc, number, card.number, card.number), 'رقم البطاقة');
  } else {
    failed.push('رقم البطاقة (لم يُعثر على الحقل)');
  }
  {

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
    return { ok: true, filled, failed, cvcFocused, report };
  }
}

module.exports = { fillCard, typeKeys };
