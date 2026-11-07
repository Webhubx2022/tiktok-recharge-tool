# الشرح التقني

## نظرة عامة

تطبيق Electron بنافذة واحدة. الواجهة (renderer) صفحة HTML/JS عادية بدون إطار عمل، وصفحات تيك توك تُعرض داخل `WebContentsView` منفصل لكل عميل، كل واحد في **session/partition** خاص به.

```
┌──────────────────────────── BrowserWindow ────────────────────────────┐
│  renderer (src/renderer)                                              │
│  ┌──────────── tabs / toolbar / QR bar ───────────┐ ┌── sidebar ────┐ │
│  ├─────────────────────────────────────────────────┤ │ customers     │ │
│  │  WebContentsView  (persist:cust_<id>)           │ │ toasts        │ │
│  │  tiktok.com  + preload/tiktok.js                │ │ log/cards/... │ │
│  └─────────────────────────────────────────────────┘ └───────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
                 ▲ IPC (preload/ui.js, قائمة قنوات مسموحة)
                 ▼
      main process (src/main): store · sessions · qr · cardfill · vault · capture
```

الـ `WebContentsView` طبقة أصلية فوق الواجهة: الواجهة ترسل مستطيل `#viewport` (`view:bounds`) والعملية الرئيسية تضع التبويب النشط عليه. عند فتح أي نافذة منبثقة في الواجهة تُخفى الطبقة (`view:overlay`) حتى لا تغطيها، ولهذا تظهر الرسائل (toasts) في الشريط الجانبي.

## الملفات

| الملف | الدور |
|---|---|
| `src/main/main.js` | النافذة، التبويبات، اكتشاف الدخول، الإيصالات، الاختصارات، كل معالجات IPC |
| `src/main/store.js` | تخزين JSON (`data.json`): العملاء، العمليات، الإعدادات، hash الـ PIN، البطاقات المشفّرة. كتابة ذرّية (tmp + rename) ونسخة احتياطية عند تلف الملف |
| `src/main/sessions.js` | `session.fromPartition('persist:cust_<id>')`، User-Agent كروم عادي، رفض الأذونات، فحص كوكيز الدخول، المسح |
| `src/main/qr.js` | `QrWatcher`: استخراج رابط QR وحالته |
| `src/main/cardfill.js` | اكتشاف خانات البطاقة في كل الإطارات وتعبئتها |
| `src/main/vault.js` | تشفير البطاقات بـ `safeStorage`، التحقق (Luhn، التاريخ)، العرض المقنّع |
| `src/main/capture.js` | لقطة الصفحة وحفظها في `Documents\TT Recharge\Receipts` |
| `src/preload/ui.js` | `contextBridge` للواجهة مع قائمة بيضاء للقنوات |
| `src/preload/tiktok.js` | يعمل داخل صفحات تيك توك: يراقب نافذة «اكتمل الشراء» |
| `src/renderer/*` | الواجهة العربية RTL |
| `build/afterPack.js` | Electron Fuses للنسخة المثبّتة |
| `tests/` | اختبار التعبئة على صفحات دفع محلية |

## طريقة عمل كل جزء

### جلسة لكل عميل

- كل عميل له معرّف hex من 12 حرفاً، وجلسته `persist:cust_<id>` تُحفظ في `%APPDATA%\TT Recharge\Partitions\cust_<id>`.
- User-Agent مضبوط على كروم عادي (بدون كلمة Electron) بنفس رقم إصدار Chromium.
- **اكتشاف الدخول:** الاستماع لـ `cookies.on('changed')` على كوكيز `sessionid` / `sessionid_ss` / `sid_tt`، ثم إعادة الفحص بعد 800ms (`checkAuth`). عند الدخول: الحالة `active` والانتقال إلى `/coin`. عند الخروج: `expired` والعودة لصفحة QR.
- بعد الدخول تحاول الأداة جلب اليوزر من `/passport/web/account/info/` (إن فشل يمكن كتابته يدوياً).
- عند فتح التطبيق، تُفحص كوكيز كل العملاء غير الجدد لتحديث حالتهم (`refreshStatuses`).
- حذف العميل يمسح بيانات الجلسة فوراً، ويُحذف مجلدها عند التشغيل التالي (`pendingCleanup`) لأنه قد يكون مقفولاً أثناء التشغيل.

### استخراج رابط QR (`qr.js`)

الرابط المُرسل للعميل هو **نفس الرابط المرسوم داخل الـ QR** (`https://www.tiktok.com/t/…`):

1. **الأساسي:** `webContents.debugger` (بروتوكول DevTools) مع `Network.enable`.
   - رد `…/passport/web/get_qrcode/` يعطي `token` للرمز الجديد. الأداة تحفظ الـ token وتلغي أي رابط قديم.
   - الصفحة بعدها تستدعي `/shorten/`، والرد فيه `data[].short_url` و`target`. تُعتمد `short_url` فقط إذا كان `target` فيه نفس الـ token.
   - ⚠️ لا تستخدم `qrcode_index_url` من رد `get_qrcode`: هذا الرابط ينقصه `app_type=m` و`client_secret` الموجودان في رابط الـ QR الفعلي.
2. **الاحتياطي:** كل 2.5 ثانية تُلتقط الصفحة وتُقرأ بـ `jsQR` إذا لم يصل رابط من الـ API. بعد صدور رمز جديد تنتظر 3 ثوانٍ قبل القراءة، حتى لا تقرأ صورة الرمز القديم.
3. **الحالة:** من ردود `…/check_qrconnect/` (`new` / `scanned` / `confirmed` / `expired`). تيك توك يستعلم من 3 مناطق معاً (us / eu / sg)، والمنطقة الأصلية للحساب فقط تعرف أن العميل مسح الرمز. لذلك الحالة تتقدم فقط ولا ترجع للخلف، و`expired` لا تُعتمد إلا إذا لم تأتِ حالة حيّة من أي منطقة لمدة 5 ثوانٍ. عند الانتهاء الفعلي تُعاد تحميل الصفحة.
4. إذا لم يظهر رابط خلال 20 ثانية تُعاد تحميل الصفحة (حتى مرتين) — `scheduleQrRetry`.

### الإيصال التلقائي

`preload/tiktok.js` يعمل في عالم معزول، ويراقب DOM بـ `MutationObserver` (مع تأخير 400ms، وفقط على مسارات `/coin`). عند ظهور نص مثل «اكتمل الشراء» يستخرج عدد العملات («شحنت 350 عملة») والإجمالي إن وُجد، ويرسل `tt:purchase`. العملية الرئيسية تنتظر 900ms (حركة النافذة)، تلتقط الصفحة، تحفظها، تنسخها للحافظة وتسجّل العملية. لا تُسجَّل أكثر من عملية لنفس التبويب خلال 8 ثوانٍ.

لدعم لغة أو نص جديد: أضف نمطاً إلى `SUCCESS` في `src/preload/tiktok.js`.

### تعبئة البطاقة (`cardfill.js`)

1. **المسح:** لكل إطار في `wc.mainFrame.framesInSubtree` (بما فيها إطارات شركات الدفع من نطاقات أخرى) يُنفّذ `FRAME_SCAN` عبر `WebFrameMain.executeJavaScript`. يصنّف الخانات حسب `autocomplete` و`name` و`id` و`placeholder` و`aria-label` و`data-fieldtype` والـ `label`. إذا كان الإطار فيه خانة واحدة فقط، يُستخدم عنوانه واسمه ورابطه (حالة Adyen وأمثالها). كل خانة تُعلَّم بـ `data-ttfill`.
2. **التركيز:** `el.focus()` داخل الإطار، وإن رفض المزوّد يُحسب موقع الخانة عبر سلسلة الإطارات وتُرسل نقرة حقيقية (`sendInputEvent`).
3. **الكتابة:** `selectAll` ثم ضغطات مفاتيح حقيقية حرفاً حرفاً، حتى تعمل خانات التنسيق التلقائي. بعدها تُقرأ القيمة للتحقق: الرقم يُعاد بمجموعات من 4 أرقام إن لزم، والتاريخ يُجرَّب `MM/YY` ثم `MMYY`، والقوائم المنسدلة تُضبط مباشرة.
4. في النهاية يوضع المؤشر في خانة CVV.

**أين تُكتب البطاقة:** فقط في `https://*.tiktok.com` أو النوافذ المنبثقة التي فتحتها تلك الصفحات (`fillAllowed`). المتغيّر `TT_FILL_ANY_HOST=1` يرفع هذا القيد **للاختبار فقط**.

**لتحسين الاكتشاف** لصفحة دفع جديدة: أضف الكلمات إلى `RX` في `FRAME_SCAN`، ثم أضف صفحة مشابهة إلى `tests/pages/` واختبرها.

### البطاقات (`vault.js`)

`safeStorage.encryptString(JSON)` ← base64 داخل `data.cards[].enc`. الواجهة تستلم فقط `{label, brand, last4, expiry, isDefault}`. رمز CVV لا يُقبل ولا يُحفظ.

### الأمان في العملية الرئيسية

- كل معالجات IPC (ما عدا `auth:*` و`view:overlay`) ترفض الطلب أثناء القفل.
- PIN: `scrypt` + salt 16 بايت، مقارنة `timingSafeEqual`، انتظار متزايد بعد 5 محاولات.
- الواجهة: `contextIsolation` و`sandbox` وCSP صارم (`script-src 'self'`)، ولا تنقّل ولا نوافذ جديدة.
- صفحات تيك توك: `sandbox`، والأذونات كلها مرفوضة ما عدا كتابة الحافظة وملء الشاشة.
- Fuses في النسخة المثبّتة: `EnableCookieEncryption` مفعّل، `RunAsNode` و`NODE_OPTIONS` و`--inspect` معطّلة.

## قنوات IPC

| القناة | الوظيفة |
|---|---|
| `auth:state` · `auth:setup` · `auth:unlock` · `auth:lock` · `auth:change` | PIN والقفل |
| `customers:list` · `customers:create` · `customers:update` · `customers:remove` | العملاء |
| `tabs:open` · `tabs:close` · `tabs:activate` · `tabs:state` | التبويبات |
| `view:nav` (`coin` / `login` / `reload` / `back`) · `view:overlay` · `view:bounds` | الصفحة |
| `qr:copy` · `qr:whatsapp` · `qr:relogin` | رابط الدخول |
| `capture:now` · `tx:list` · `tx:copy` · `tx:open` · `tx:whatsapp` · `receipts:folder` | الإيصالات والسجل |
| `cards:list` · `cards:add` · `cards:remove` · `cards:default` · `cards:fill` | البطاقات |
| `settings:get` · `settings:set` | الإعدادات |

أحداث من العملية الرئيسية للواجهة: `tabs` · `customers` · `toast` · `purchase` · `locked`.

## شكل `data.json`

```json
{
  "version": 1,
  "auth": { "pinHash": "…", "salt": "…" },
  "settings": { "countryCode": "249", "whatsappMode": "web", "linkMessage": "…", "doneMessage": "…", "defaultCardId": "…" },
  "customers": [{ "id": "1535b5f77390", "name": "…", "phone": "…", "username": "…", "nickname": "…", "notes": "", "status": "active|expired|new", "createdAt": 0, "lastUsedAt": 0 }],
  "transactions": [{ "id": "…", "at": 0, "kind": "auto|manual", "customerId": "…", "customerName": "…", "username": "…", "coins": 350, "amount": "US$3.65", "file": "C:\\…\\.png" }],
  "cards": [{ "id": "…", "label": "…", "brand": "Visa", "last4": "4242", "expiry": "12/30", "enc": "<DPAPI base64>" }],
  "pendingCleanup": []
}
```

## التطوير والاختبار

```bash
npm install
```

```bash
npm start
```

```bash
npm test
```

`npm test` يشغّل `tests/card-fill.test.js`: يفتح التطبيق بمجلد بيانات مؤقت، ويضيف البطاقة التجريبية `4242 4242 4242 4242` من الواجهة، ويتأكد أنها محفوظة مشفّرة وأن الرقم الخاطئ مرفوض. بعدها يعبّئها في صفحتين محليتين: الأولى فيها الرقم وCVV داخل إطارات منفصلة وتاريخ بتنسيق تلقائي، والثانية فيها قوائم منسدلة للشهر والسنة. يطبع 12 فحصاً.

متغيرات بيئة للتطوير:

| المتغيّر | الأثر |
|---|---|
| `TT_USER_DATA=<مجلد>` | استخدام مجلد بيانات آخر بدل `%APPDATA%\TT Recharge` (للاختبار) |
| `TT_FILL_ANY_HOST=1` | السماح بتعبئة البطاقة في أي صفحة (للاختبار فقط) |

## البناء والإصدار

```bash
npm run dist
```

الناتج `dist\TT Recharge Setup <version>.exe` (NSIS، يتيح اختيار مجلد التثبيت، واختصار «شحن تيك توك» على سطح المكتب). `build/afterPack.js` يطبّق الـ Fuses على الملف التنفيذي. للتحقق:

```bash
npx @electron/fuses read --app "dist/win-unpacked/TT Recharge.exe"
```

لإصدار جديد: غيّر `version` في `package.json`، وأضف التغييرات إلى `CHANGELOG.md`، ثم `npm run dist`. الملف غير موقّع رقمياً، لذلك قد يعرض ويندوز تحذير SmartScreen عند التثبيت («مزيد من المعلومات» ← «تشغيل على أي حال»).

## نقاط تعتمد على تيك توك

هذه أجزاء قد تحتاج تعديلاً إذا غيّر تيك توك موقعه:

| الجزء | المكان |
|---|---|
| رابط صفحة QR (`/login/qrcode`) وصفحة الشحن (`/coin`) | `LOGIN_URL` و`COIN_URL` في `main.js` |
| أسماء كوكيز الدخول | `AUTH_COOKIES` في `sessions.js` |
| مسارات `get_qrcode` / `shorten` / `check_qrconnect` والحقول `token` و`short_url` و`target` | `qr.js` |
| نص «اكتمل الشراء» وصيغة عدد العملات | `src/preload/tiktok.js` |
| أسماء خانات البطاقة في نموذج الدفع | `RX` في `cardfill.js` |
