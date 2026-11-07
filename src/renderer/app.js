'use strict';

const ipc = window.api;
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { customers: [], tabs: [], activeId: null, search: '' };

const STATUS = {
  active: { label: 'مسجّل', cls: 'ok' },
  expired: { label: 'يحتاج دخول', cls: 'err' },
  new: { label: 'جديد', cls: '' },
};

const QR_STATUS = {
  new: '⏳ بانتظار العميل يفتح الرابط ويوافق',
  scanned: '📱 العميل فتح الرابط — بانتظار الموافقة',
  confirmed: '✅ تمت الموافقة — جاري الدخول…',
  expired: '⏱️ انتهت صلاحية الرمز — جاري تجهيز رمز جديد',
};

async function call(channel, ...args) {
  try {
    return await ipc.invoke(channel, ...args);
  } catch (err) {
    const msg = String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    toast(msg, 'err');
    throw err;
  }
}

// ------------------------------------------------------------ overlay & bounds
// The TikTok page is a native view drawn over #viewport, so it is hidden while
// any modal is open.
let overlays = 0;
function pushOverlay() {
  if (overlays++ === 0) ipc.invoke('view:overlay', true);
}
function popOverlay() {
  overlays = Math.max(0, overlays - 1);
  if (overlays === 0) ipc.invoke('view:overlay', false);
}

const viewport = $('#viewport');
function sendBounds() {
  const r = viewport.getBoundingClientRect();
  ipc.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
}
new ResizeObserver(sendBounds).observe(viewport);
window.addEventListener('resize', sendBounds);

// ------------------------------------------------------------ toasts
function toast(msg, type = 'info', { actions = [], timeout = 4500 } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<div class="head"><div class="msg"></div><button class="close" title="إغلاق">✕</button></div>`;
  $('.msg', el).textContent = msg;
  const close = () => el.remove();
  $('.close', el).onclick = close;
  if (actions.length) {
    const box = document.createElement('div');
    box.className = 'actions';
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = `btn sm ${a.cls || ''}`;
      b.textContent = a.label;
      b.onclick = () => a.onClick(close);
      box.append(b);
    }
    el.append(box);
  }
  $('#toasts').append(el);
  const all = $('#toasts').children;
  while (all.length > 4) all[0].remove();
  if (timeout) setTimeout(close, timeout);
  return close;
}

// ------------------------------------------------------------ modals
function openModal({ title, content, actions = [], wide = false, onClose }) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}">
      <div class="modal-head"><h3></h3><button class="icon-btn" data-x title="إغلاق">✕</button></div>
      <div class="modal-body"></div>
      <div class="modal-foot"></div>
    </div>`;
  $('h3', back).textContent = title;
  const body = $('.modal-body', back);
  if (typeof content === 'string') body.innerHTML = content;
  else body.append(content);

  let closed = false;
  const onKey = (e) => {
    if (e.key === 'Escape' && $('#modal-root').lastElementChild === back) close();
  };
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    back.remove();
    popOverlay();
    if (onClose) onClose();
  }

  const foot = $('.modal-foot', back);
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = `btn ${a.cls || ''}`;
    b.textContent = a.label;
    b.type = 'button';
    b.onclick = () => a.onClick({ close, body, button: b });
    foot.append(b);
  }
  $('[data-x]', back).onclick = close;
  back.addEventListener('mousedown', (e) => {
    if (e.target === back) close();
  });
  document.addEventListener('keydown', onKey);
  $('#modal-root').append(back);
  pushOverlay();
  // focus the first field, unless the user already clicked into the dialog
  setTimeout(() => {
    if (!back.contains(document.activeElement)) $('input:not([readonly]),textarea,select', body)?.focus();
  }, 30);
  return { close, body };
}

function confirmModal(title, message, { okLabel = 'تأكيد', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const p = document.createElement('p');
    p.textContent = message;
    p.style.lineHeight = '1.8';
    openModal({
      title,
      content: p,
      onClose: () => !answered && resolve(false),
      actions: [
        { label: okLabel, cls: danger ? 'danger' : 'primary', onClick: ({ close }) => { answered = true; close(); resolve(true); } },
        { label: 'إلغاء', cls: 'ghost', onClick: ({ close }) => close() },
      ],
    });
  });
}

// ------------------------------------------------------------ customers list
function initials(name) {
  return (String(name).trim()[0] || '؟').toUpperCase();
}

function renderList() {
  const q = state.search.trim().toLowerCase();
  const openIds = new Set(state.tabs.map((t) => t.id));
  const items = state.customers.filter(
    (c) => !q || [c.name, c.phone, c.username, c.nickname].some((v) => String(v || '').toLowerCase().includes(q))
  );
  const list = $('#customer-list');
  if (!state.customers.length) {
    list.innerHTML = `<div class="list-empty">لا يوجد عملاء بعد<br>اضغط «＋ عميل جديد» للبدء</div>`;
  } else if (!items.length) {
    list.innerHTML = `<div class="list-empty">لا توجد نتائج</div>`;
  } else {
    list.innerHTML = items
      .map((c) => {
        const st = STATUS[c.status] || STATUS.new;
        const sub = [c.username ? `@${c.username}` : '', c.phone].filter(Boolean).join(' · ') || st.label;
        return `
          <div class="customer ${c.id === state.activeId ? 'active' : ''}" data-id="${esc(c.id)}" title="${esc(st.label)}">
            <div class="avatar">${esc(initials(c.name))}<span class="dot ${st.cls}"></span></div>
            <div class="meta">
              <strong>${esc(c.name)}</strong>
              <span dir="auto">${esc(sub)}</span>
            </div>
            ${openIds.has(c.id) ? '<span class="open-badge">● مفتوح</span>' : ''}
          </div>`;
      })
      .join('');
  }
  const active = state.customers.filter((c) => c.status === 'active').length;
  $('#stats').textContent = `${state.customers.length} عميل · ${active} مسجّل`;
}

$('#customer-list').addEventListener('click', (e) => {
  const item = e.target.closest('.customer');
  if (item) call('tabs:open', item.dataset.id).catch(() => {});
});
$('#search').addEventListener('input', (e) => {
  state.search = e.target.value;
  renderList();
});

// ------------------------------------------------------------ tabs & toolbar
function activeTab() {
  return state.tabs.find((t) => t.id === state.activeId) || null;
}
function customerById(id) {
  return state.customers.find((c) => c.id === id) || null;
}

function renderTabs() {
  const box = $('#tabs');
  if (!state.tabs.length) {
    box.innerHTML = `<div class="tabs-empty">اختر عميلاً من القائمة لفتح حسابه</div>`;
    return;
  }
  box.innerHTML = state.tabs
    .map((t) => {
      const st = t.loggedIn ? 'ok' : t.mode === 'login' ? 'warn' : '';
      return `
        <div class="tab ${t.id === state.activeId ? 'active' : ''}" data-id="${esc(t.id)}">
          ${t.loading ? '<span class="spin"></span>' : `<span class="dot ${st}"></span>`}
          <span class="name">${esc(t.name)}</span>
          <button class="x" data-close="${esc(t.id)}" title="إغلاق التبويب">✕</button>
        </div>`;
    })
    .join('');
}

$('#tabs').addEventListener('click', (e) => {
  const closeId = e.target.closest('[data-close]')?.dataset.close;
  if (closeId) {
    call('tabs:close', closeId).catch(() => {});
    return;
  }
  const tab = e.target.closest('.tab');
  if (tab) call('tabs:activate', tab.dataset.id).catch(() => {});
});

function renderToolbar() {
  const t = activeTab();
  $('#empty').hidden = !!t;
  $('#toolbar').hidden = !t;
  const showQr = !!t && t.mode === 'login' && !t.loggedIn;
  $('#qrbar').hidden = !showQr;
  if (!t) {
    requestAnimationFrame(sendBounds);
    return;
  }
  const c = customerById(t.id);
  $('#tb-name').textContent = c?.name || t.name;
  $('#tb-user').textContent = c?.username ? `@${c.username}` : '';
  const pill = $('#tb-status');
  const dot = $('#tb-dot');
  if (!t.url) {
    pill.textContent = 'جاري التحميل…';
    pill.className = 'pill';
    dot.className = 'dot';
  } else if (t.loggedIn) {
    pill.textContent = t.mode === 'coin' ? 'مسجّل · صفحة الشحن' : 'مسجّل';
    pill.className = 'pill ok';
    dot.className = 'dot ok';
  } else if (t.mode === 'login') {
    pill.textContent = 'بانتظار تسجيل الدخول';
    pill.className = 'pill warn';
    dot.className = 'dot warn';
  } else {
    pill.textContent = 'غير مسجّل';
    pill.className = 'pill err';
    dot.className = 'dot err';
  }
  $('#tb-back').disabled = !t.canGoBack;
  $('#tb-coin').disabled = !t.loggedIn;

  if (showQr) {
    $('#qr-url').value = t.qrUrl || '';
    $('#qr-copy').disabled = !t.qrUrl;
    $('#qr-wa').disabled = !t.qrUrl;
    $('#qr-status').textContent = t.qrUrl
      ? QR_STATUS[t.qrStatus] || QR_STATUS.new
      : 'جاري قراءة رمز QR من الصفحة… (إذا لم يظهر اضغط «استخدام رمز QR» داخل الصفحة)';
  }
  requestAnimationFrame(sendBounds);
}

$('#tb-back').onclick = () => call('view:nav', 'back').catch(() => {});
$('#tb-reload').onclick = () => call('view:nav', 'reload').catch(() => {});
$('#tb-coin').onclick = () => call('view:nav', 'coin').catch(() => {});
$('#tb-capture').onclick = () => call('capture:now').catch(() => {});
$('#tb-edit').onclick = () => {
  const c = customerById(state.activeId);
  if (c) customerModal(c);
};

$('#qr-copy').onclick = async () => {
  await call('qr:copy').catch(() => null) && toast('تم نسخ رابط الدخول 📋', 'ok', { timeout: 2000 });
};
$('#qr-wa').onclick = () =>
  call('qr:whatsapp')
    .then(() => toast('تم فتح واتساب — الرابط منسوخ أيضاً', 'ok', { timeout: 3000 }))
    .catch(() => {});
$('#qr-new').onclick = () => call('view:nav', 'login').catch(() => {});
$('#qr-url').addEventListener('focus', (e) => e.target.select());

// track the previous QR link of each tab to tell the operator when it changes
const lastQr = new Map();
function noticeQrChanges() {
  for (const t of state.tabs) {
    const prev = lastQr.get(t.id);
    if (t.qrUrl && prev && prev !== t.qrUrl && t.mode === 'login' && !t.loggedIn) {
      toast(`🔄 تم تجديد رابط الدخول لـ ${t.name} — أرسل الرابط الجديد للعميل`, 'warn', { timeout: 7000 });
    }
    if (t.qrUrl) lastQr.set(t.id, t.qrUrl);
  }
}

// ------------------------------------------------------------ customer form
function customerModal(c) {
  const isNew = !c;
  const form = document.createElement('form');
  form.className = 'form';
  form.innerHTML = `
    <label>اسم العميل *<input id="f-name" maxlength="60" placeholder="مثال: محمد أحمد"></label>
    <label>رقم الواتساب<input id="f-phone" dir="ltr" maxlength="20" placeholder="0912345678"></label>
    ${isNew ? '' : '<label>يوزر تيك توك<input id="f-user" dir="ltr" maxlength="40" placeholder="username"></label>'}
    <label>ملاحظات<textarea id="f-notes" rows="2" maxlength="300"></textarea></label>
    ${isNew ? '<p class="hint">بعد الحفظ يُفتح تبويب للعميل ويظهر رابط الدخول لإرساله له.</p>' : `
      <div class="danger-zone">
        <button type="button" class="btn ghost sm" id="f-folder">📁 إيصالات العميل</button>
        <button type="button" class="btn ghost sm" id="f-relogin">🔄 تسجيل دخول جديد (QR)</button>
        <button type="button" class="btn danger sm" id="f-delete">🗑️ حذف العميل</button>
      </div>`}
  `;
  $('#f-name', form).value = c?.name || '';
  $('#f-phone', form).value = c?.phone || '';
  if (!isNew) $('#f-user', form).value = c.username || '';
  $('#f-notes', form).value = c?.notes || '';

  const save = async ({ close, button }) => {
    const data = {
      name: $('#f-name', form).value.trim(),
      phone: $('#f-phone', form).value.trim(),
      notes: $('#f-notes', form).value.trim(),
    };
    if (!data.name) {
      $('#f-name', form).focus();
      toast('اسم العميل مطلوب', 'err');
      return;
    }
    button.disabled = true;
    try {
      if (isNew) {
        const created = await call('customers:create', data);
        close();
        await call('tabs:open', created.id);
      } else {
        data.username = $('#f-user', form).value.trim();
        await call('customers:update', c.id, data);
        close();
        toast('تم حفظ بيانات العميل', 'ok', { timeout: 2000 });
      }
    } catch {
      button.disabled = false;
    }
  };

  const m = openModal({
    title: isNew ? 'عميل جديد' : `بيانات العميل — ${c.name}`,
    content: form,
    actions: [
      { label: isNew ? 'حفظ وفتح رابط الدخول' : 'حفظ', cls: 'primary', onClick: save },
      { label: 'إلغاء', cls: 'ghost', onClick: ({ close }) => close() },
    ],
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    m.body.closest('.modal').querySelector('.modal-foot .btn.primary').click();
  });

  if (!isNew) {
    $('#f-folder', form).onclick = () => call('receipts:folder', c.id).catch(() => {});
    $('#f-relogin', form).onclick = async () => {
      const ok = await confirmModal(
        'تسجيل دخول جديد',
        `سيتم مسح جلسة حساب "${c.name}" من الأداة وإنشاء رمز QR جديد. استخدمه إذا أراد العميل شحن حساب آخر أو إذا كانت الجلسة لا تعمل.`,
        { okLabel: 'متابعة' }
      );
      if (!ok) return;
      m.close();
      call('qr:relogin', c.id).catch(() => {});
    };
    $('#f-delete', form).onclick = async () => {
      const ok = await confirmModal(
        'حذف العميل',
        `حذف "${c.name}" نهائياً؟ سيتم مسح جلسة تيك توك الخاصة به من الجهاز ولا يمكن التراجع. (سجل العمليات والإيصالات المحفوظة تبقى)`,
        { okLabel: 'حذف نهائي', danger: true }
      );
      if (!ok) return;
      m.close();
      call('customers:remove', c.id).then(() => toast(`تم حذف ${c.name}`, 'ok')).catch(() => {});
    };
  }
}

$('#btn-new').onclick = () => customerModal(null);

// ------------------------------------------------------------ purchase receipts
function txActions(tx) {
  return [
    {
      label: '💬 إرسال للعميل',
      cls: 'wa',
      onClick: () => call('tx:whatsapp', tx.id)
        .then(() => toast('الصورة منسوخة — الصقها في المحادثة بـ Ctrl+V', 'ok', { timeout: 6000 }))
        .catch(() => {}),
    },
    { label: '📋 نسخ الصورة', onClick: () => call('tx:copy', tx.id).then(() => toast('تم نسخ الصورة', 'ok', { timeout: 2000 })).catch(() => {}) },
    { label: '🖼️ فتح', cls: 'ghost', onClick: () => call('tx:open', tx.id).catch(() => {}) },
  ];
}

function onPurchase(tx) {
  const what = tx.kind === 'manual'
    ? `📸 تم حفظ لقطة لـ ${tx.customerName}`
    : `✅ تم الشحن${tx.coins ? ` ${tx.coins.toLocaleString('en-US')} عملة` : ''} — ${tx.customerName}`;
  toast(`${what}\nالصورة منسوخة في الحافظة (Ctrl+V)`, 'ok', { actions: txActions(tx), timeout: tx.kind === 'manual' ? 8000 : 0 });
}

// ------------------------------------------------------------ transactions log
function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' });
}

async function txModal() {
  const all = await call('tx:list').catch(() => null);
  if (!all) return;
  const box = document.createElement('div');
  const today = new Date().toDateString();
  const todays = all.filter((t) => t.kind !== 'manual' && new Date(t.at).toDateString() === today);
  const coinsToday = todays.reduce((s, t) => s + (t.coins || 0), 0);
  box.innerHTML = `
    <div class="tx-summary">
      <div class="card"><b>${todays.length}</b><span>عمليات شحن اليوم</span></div>
      <div class="card"><b>${coinsToday.toLocaleString('en-US')}</b><span>عملات مشحونة اليوم</span></div>
      <div class="card"><b>${all.filter((t) => t.kind !== 'manual').length}</b><span>إجمالي عمليات الشحن</span></div>
    </div>
    <div class="form"><input id="tx-search" placeholder="بحث باسم العميل أو اليوزر…"></div>
    <table class="tx-table">
      <thead><tr><th>الإيصال</th><th>التاريخ</th><th>العميل</th><th>العملات</th><th>المبلغ</th><th></th></tr></thead>
      <tbody></tbody>
    </table>`;
  const tbody = $('tbody', box);

  const render = (q = '') => {
    const rows = all.filter((t) => !q || [t.customerName, t.username].some((v) => String(v || '').toLowerCase().includes(q)));
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="muted">لا توجد عمليات</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.slice(0, 300).map((t) => `
      <tr data-id="${esc(t.id)}">
        <td><img alt="" src="${esc(fileUrl(t.file))}" data-act="open"></td>
        <td>${esc(fmtDate(t.at))}</td>
        <td>${esc(t.customerName)}${t.username ? `<br><span class="muted" dir="ltr">@${esc(t.username)}</span>` : ''}</td>
        <td>${t.kind === 'manual' ? '<span class="tag">لقطة يدوية</span>' : t.coins ? t.coins.toLocaleString('en-US') : '—'}</td>
        <td dir="ltr">${esc(t.amount || '—')}</td>
        <td><div class="acts">
          <button class="btn wa sm" data-act="wa" title="إرسال للعميل">💬</button>
          <button class="btn sm" data-act="copy" title="نسخ الصورة">📋</button>
        </div></td>
      </tr>`).join('');
  };
  render();
  $('#tx-search', box).addEventListener('input', (e) => render(e.target.value.trim().toLowerCase()));
  tbody.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const id = e.target.closest('tr')?.dataset.id;
    if (!act || !id) return;
    if (act === 'open') call('tx:open', id).catch(() => {});
    if (act === 'copy') call('tx:copy', id).then(() => toast('تم نسخ الصورة', 'ok', { timeout: 2000 })).catch(() => {});
    if (act === 'wa') call('tx:whatsapp', id).then(() => toast('الصورة منسوخة — الصقها في المحادثة بـ Ctrl+V', 'ok', { timeout: 6000 })).catch(() => {});
  });
  openModal({ title: '🧾 سجل العمليات', content: box, wide: true });
}

function fileUrl(p) {
  return `file:///${String(p).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:')}`;
}

$('#btn-tx').onclick = txModal;
$('#btn-receipts').onclick = () => call('receipts:folder').catch(() => {});

// ------------------------------------------------------------ settings
async function settingsModal() {
  const s = await call('settings:get').catch(() => null);
  if (!s) return;
  const form = document.createElement('form');
  form.className = 'form';
  form.innerHTML = `
    <label>مفتاح الدولة الافتراضي (للأرقام التي تبدأ بـ 0)
      <input id="s-cc" dir="ltr" maxlength="4">
    </label>
    <label>فتح واتساب عبر
      <select id="s-wa">
        <option value="web">رابط wa.me (يعمل دائماً)</option>
        <option value="app">تطبيق واتساب للكمبيوتر مباشرة</option>
      </select>
    </label>
    <label>رسالة رابط الدخول
      <textarea id="s-link" rows="5"></textarea>
      <span class="hint">المتغيرات: {name} اسم العميل · {link} رابط الدخول</span>
    </label>
    <label>رسالة نجاح الشحن
      <textarea id="s-done" rows="3"></textarea>
      <span class="hint">المتغيرات: {name} · {username} · {coins_text} · {amount}</span>
    </label>
    <fieldset>
      <legend>تغيير رمز PIN</legend>
      <input id="s-old" type="password" inputmode="numeric" maxlength="8" placeholder="الرمز الحالي" dir="ltr">
      <input id="s-new" type="password" inputmode="numeric" maxlength="8" placeholder="الرمز الجديد (4-8 أرقام)" dir="ltr">
    </fieldset>`;
  $('#s-cc', form).value = s.countryCode;
  $('#s-wa', form).value = s.whatsappMode;
  $('#s-link', form).value = s.linkMessage;
  $('#s-done', form).value = s.doneMessage;
  form.addEventListener('submit', (e) => e.preventDefault());

  openModal({
    title: '⚙️ الإعدادات',
    content: form,
    actions: [
      {
        label: 'حفظ',
        cls: 'primary',
        onClick: async ({ close }) => {
          try {
            const oldPin = $('#s-old', form).value;
            const newPin = $('#s-new', form).value;
            if (oldPin || newPin) await call('auth:change', { oldPin, newPin });
            await call('settings:set', {
              countryCode: $('#s-cc', form).value.replace(/\D/g, ''),
              whatsappMode: $('#s-wa', form).value,
              linkMessage: $('#s-link', form).value,
              doneMessage: $('#s-done', form).value,
            });
            close();
            toast('تم حفظ الإعدادات', 'ok', { timeout: 2000 });
          } catch { /* toast already shown */ }
        },
      },
      { label: 'إلغاء', cls: 'ghost', onClick: ({ close }) => close() },
    ],
  });
}
$('#btn-settings').onclick = settingsModal;

// ------------------------------------------------------------ saved cards
async function cardsModal() {
  const res = await call('cards:list').catch(() => null);
  if (!res) return;
  const box = document.createElement('div');
  box.innerHTML = `
    <div class="cards-list"></div>
    <form class="form" autocomplete="off">
      <fieldset>
        <legend>إضافة بطاقة</legend>
        <label>اسم للبطاقة (اختياري)<input id="c-label" maxlength="30" placeholder="مثال: بطاقة الشركة"></label>
        <label>رقم البطاقة<input id="c-number" dir="ltr" inputmode="numeric" maxlength="23" placeholder="0000 0000 0000 0000"></label>
        <div class="row2">
          <label>تاريخ الانتهاء<input id="c-exp" dir="ltr" inputmode="numeric" maxlength="7" placeholder="MM/YY"></label>
          <label>الاسم على البطاقة<input id="c-holder" dir="ltr" maxlength="60" placeholder="NAME SURNAME"></label>
        </div>
        <span class="hint">🔒 تُحفظ البطاقة مشفّرة بتشفير ويندوز على هذا الجهاز فقط، ولا تظهر كاملة مرة أخرى.
          رمز CVV لا يُحفظ — تكتبه أنت عند الدفع (3 أرقام).</span>
        <button class="btn primary" type="submit" id="c-add">＋ حفظ البطاقة</button>
      </fieldset>
    </form>`;
  const list = $('.cards-list', box);
  const render = (cards) => {
    if (!cards.length) {
      list.innerHTML = '<p class="muted">لا توجد بطاقات محفوظة بعد.</p>';
      return;
    }
    list.innerHTML = cards.map((c) => `
      <div class="card-row ${c.isDefault ? 'default' : ''}" data-id="${esc(c.id)}">
        <div class="card-chip">${esc(c.brand.slice(0, 4).toUpperCase())}</div>
        <div class="cinfo">
          <strong>${esc(c.label)} ${c.isDefault ? '<span class="tag">الافتراضية</span>' : ''}</strong>
          <span class="num muted" dir="ltr">•••• •••• •••• ${esc(c.last4)} · ${esc(c.expiry)}</span>
        </div>
        ${c.isDefault ? '' : '<button class="btn sm ghost" data-act="default">اجعلها الافتراضية</button>'}
        <button class="btn sm danger" data-act="remove">حذف</button>
      </div>`).join('');
  };
  render(res.cards);
  if (!res.available) {
    $('#c-add', box).disabled = true;
    $('.hint', box).textContent = '⚠️ التشفير غير متاح على هذا الجهاز، لذلك لا يمكن حفظ البطاقات.';
  }

  // light formatting while typing
  $('#c-number', box).addEventListener('input', (e) => {
    const d = e.target.value.replace(/\D/g, '').slice(0, 19);
    e.target.value = d.replace(/(\d{4})(?=\d)/g, '$1 ');
  });
  $('#c-exp', box).addEventListener('input', (e) => {
    const d = e.target.value.replace(/\D/g, '').slice(0, 4);
    e.target.value = d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
  });

  list.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const row = e.target.closest('.card-row');
    if (!act || !row) return;
    if (act === 'default') render(await call('cards:default', row.dataset.id).catch(() => res.cards));
    if (act === 'remove') {
      const ok = await confirmModal('حذف البطاقة', 'حذف هذه البطاقة من الأداة؟', { okLabel: 'حذف', danger: true });
      if (ok) render(await call('cards:remove', row.dataset.id).catch(() => res.cards));
    }
  });

  $('form', box).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#c-add', box);
    btn.disabled = true;
    try {
      const cards = await call('cards:add', {
        label: $('#c-label', box).value,
        number: $('#c-number', box).value,
        expiry: $('#c-exp', box).value,
        holder: $('#c-holder', box).value,
      });
      render(cards);
      ['#c-label', '#c-number', '#c-exp', '#c-holder'].forEach((s) => { $(s, box).value = ''; });
      toast('تم حفظ البطاقة 🔒', 'ok', { timeout: 2500 });
    } catch { /* toast shown */ }
    btn.disabled = false;
  });

  openModal({ title: '💳 البطاقات المحفوظة', content: box });
}

$('#btn-cards').onclick = cardsModal;
$('#tb-fill').onclick = () => call('cards:fill').catch(() => {});

// ------------------------------------------------------------ lock screen
let lockMode = 'unlock';
function showLock(hasPin) {
  lockMode = hasPin ? 'unlock' : 'setup';
  $('#lock').hidden = false;
  $('#lock-pin2').hidden = hasPin;
  $('#lock-hint').textContent = hasPin
    ? 'أدخل رمز PIN لفتح الأداة'
    : 'أول تشغيل: اختر رمز PIN (4-8 أرقام) لحماية حسابات العملاء المحفوظة';
  $('#lock-submit').textContent = hasPin ? 'دخول' : 'حفظ الرمز والدخول';
  $('#lock-error').textContent = '';
  $('#lock-pin').value = '';
  $('#lock-pin2').value = '';
  setTimeout(() => $('#lock-pin').focus(), 50);
}

$('#lock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pin = $('#lock-pin').value.trim();
  const err = $('#lock-error');
  err.textContent = '';
  try {
    if (lockMode === 'setup') {
      if (!/^\d{4,8}$/.test(pin)) { err.textContent = 'الرمز يجب أن يكون من 4 إلى 8 أرقام'; return; }
      if (pin !== $('#lock-pin2').value.trim()) { err.textContent = 'الرمزان غير متطابقين'; return; }
      await ipc.invoke('auth:setup', pin);
    } else {
      const res = await ipc.invoke('auth:unlock', pin);
      if (!res.ok) {
        err.textContent = res.wait ? `محاولات كثيرة — انتظر ${res.wait} ثانية` : 'رمز PIN غير صحيح';
        $('#lock-pin').select();
        return;
      }
    }
    $('#lock').hidden = true;
    await refreshAll();
  } catch (ex) {
    err.textContent = String(ex.message || ex).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
});

$('#btn-lock').onclick = () => ipc.invoke('auth:lock');

// ------------------------------------------------------------ events & boot
function renderAll() {
  renderList();
  renderTabs();
  renderToolbar();
}

ipc.on('customers', (list) => {
  state.customers = list || [];
  renderAll();
});
ipc.on('tabs', (data) => {
  state.tabs = data.tabs || [];
  state.activeId = data.activeId;
  noticeQrChanges();
  renderAll();
});
ipc.on('toast', ({ msg, type }) => toast(msg, type, { timeout: type === 'warn' ? 7000 : 4500 }));
ipc.on('purchase', onPurchase);
ipc.on('locked', () => {
  document.querySelectorAll('.modal-back').forEach((m) => m.remove());
  overlays = 0;
  ipc.invoke('view:overlay', false);
  showLock(true);
});

async function refreshAll() {
  const [customers, tabs] = await Promise.all([ipc.invoke('customers:list'), ipc.invoke('tabs:state')]);
  state.customers = customers;
  state.tabs = tabs.tabs;
  state.activeId = tabs.activeId;
  renderAll();
}

(async function boot() {
  renderAll();
  const auth = await ipc.invoke('auth:state');
  if (auth.locked) showLock(auth.hasPin);
  else await refreshAll();
})();
