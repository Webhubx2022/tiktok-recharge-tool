// Receipt screenshots: saved per customer under Documents\TT Recharge\Receipts.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

function receiptsRoot() {
  return path.join(app.getPath('documents'), 'TT Recharge', 'Receipts');
}

function customerDir(customer) {
  const safe =
    String(customer?.name || '')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .trim()
      .slice(0, 40) || 'customer';
  const id = customer?.id ? `_${customer.id.slice(0, 6)}` : '';
  return path.join(receiptsRoot(), `${safe}${id}`);
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_` +
    `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  );
}

async function captureReceipt(wc, customer, tag = '') {
  const image = await wc.capturePage();
  if (image.isEmpty()) throw new Error('empty capture');
  const dir = customerDir(customer);
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${stamp()}${tag ? `_${tag}` : ''}.png`);
  await fs.promises.writeFile(file, image.toPNG());
  return { file, image };
}

module.exports = { receiptsRoot, customerDir, captureReceipt };
