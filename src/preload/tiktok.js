// Runs inside every TikTok view (isolated world). Watches the coin page for the
// "purchase complete" dialog and reports it so the app can take the receipt.
const { ipcRenderer } = require('electron');

const SUCCESS = [
  /اكتمل الشراء/,
  /تم الشراء بنجاح/,
  /تمت عملية الشراء/,
  /تم الشحن بنجاح/,
  /Purchase (?:complete|completed|successful)/i,
  /Recharge (?:complete|completed|successful)/i,
  /Payment successful/i,
];

let shown = false;
let timer = null;

function toNumber(s) {
  if (!s) return null;
  const n = Number(String(s).replace(/[,٬\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function check() {
  timer = null;
  if (!location.pathname.startsWith('/coin') || !document.body) return;
  const text = document.body.innerText || '';
  const hit = SUCCESS.some((re) => re.test(text));
  if (hit && !shown) {
    shown = true;
    const coinsMatch =
      text.match(/(?:شحنت|تم شحن|Recharged|You (?:got|received|recharged))\s*([\d,٬]+)\s*(?:عملة|عملات|coins?)/i) ||
      text.match(/([\d,٬]+)\s*(?:عملة|عملات|coins?)\s*(?:تمت|added|recharged)/i);
    const amountMatch = text.match(/(?:الإجمالي|Total)[\s:：]*((?:[A-Z]{2,3})?\s?\$\s?[\d.,]+)/i);
    ipcRenderer.send('tt:purchase', {
      coins: toNumber(coinsMatch && coinsMatch[1]),
      amount: amountMatch ? amountMatch[1].replace(/\s+/g, '') : null,
    });
  } else if (!hit) {
    shown = false;
  }
}

const observer = new MutationObserver(() => {
  if (!timer) timer = setTimeout(check, 400);
});

window.addEventListener('DOMContentLoaded', () => {
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
});
