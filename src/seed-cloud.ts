/**
 * Cloud backend demo seed
 * Creates realistic demo instances, sales, products and sync events.
 *
 * Usage:  npx ts-node src/seed-cloud.ts
 *         npm run seed:cloud
 *
 * Safe to re-run — uses INSERT OR IGNORE for instances.
 */

import 'dotenv/config';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import db from './db';

// ─── License generator (mirrors license_manager.ts) ──────────────────────────
const LICENSE_SECRET = Buffer.from(
  '4a616e75617279203173742c2032303236204c6963656e736520536563726574',
  'hex',
);
const IV_LENGTH = 12;

function genKey(issuedTo: string, plan: string, days: number): string {
  const now  = new Date();
  const exp  = new Date(now.getTime() + days * 86_400_000);
  const payload = JSON.stringify({
    id: uuidv4(), issuedTo, issuedForFingerprint: '',
    durationDays: days, maxDevices: 1,
    issuedAt: now.toISOString(), expiresAt: exp.toISOString(),
  });
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', LICENSE_SECRET, iv);
  let enc = cipher.update(payload, 'utf8', 'hex');
  enc += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${enc}`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function rnd(min: number, max: number) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function daysAgo(n: number)  { return new Date(Date.now() - n * 86_400_000).toISOString().replace('T',' ').slice(0,19); }
function hoursAgo(n: number) { return new Date(Date.now() - n * 3_600_000).toISOString().replace('T',' ').slice(0,19); }
function randDate(daysBack: number) {
  const ms = rnd(0, daysBack * 86_400_000);
  return new Date(Date.now() - ms).toISOString().replace('T',' ').slice(0,19);
}

// ─── Demo data ────────────────────────────────────────────────────────────────
const STORES = [
  { name: 'Khan General Store',  owner: 'Bilal Khan',    mobile: '03001234567', city: 'Lahore',     plan: 'yearly',    days: 365, status: 'approved', daysAgo: 0 },
  { name: 'City Mart',           owner: 'Usman Raza',    mobile: '03111234567', city: 'Karachi',    plan: 'monthly',   days: 30,  status: 'approved', daysAgo: 2 },
  { name: 'Al-Baraka Traders',   owner: 'Asim Nawaz',    mobile: '03211234567', city: 'Islamabad',  plan: 'quarterly', days: 90,  status: 'approved', daysAgo: 1 },
  { name: 'Metro Mini Market',   owner: 'Farhan Ahmed',  mobile: '03311234567', city: 'Faisalabad', plan: 'monthly',   days: 30,  status: 'approved', daysAgo: 5 },
  { name: 'Hafeez Mart',         owner: 'Hafeez Ullah',  mobile: '03451234567', city: 'Multan',     plan: 'yearly',    days: 365, status: 'approved', daysAgo: 8 },
  { name: 'Sunrise Store',       owner: 'Naveed Iqbal',  mobile: '03001119876', city: 'Peshawar',   plan: 'none',      days: 0,   status: 'pending',  daysAgo: 0 },
  { name: 'Green Valley Shop',   owner: 'Kamran Malik',  mobile: '03121119876', city: 'Quetta',     plan: 'none',      days: 0,   status: 'pending',  daysAgo: 0 },
  { name: 'Old Spice Traders',   owner: 'Tariq Javed',   mobile: '03221119876', city: 'Sialkot',    plan: 'none',      days: 0,   status: 'blocked',  daysAgo: 30 },
];

const PRODUCTS = [
  { name: 'Pepsi 1.5L',       category: 'Beverages',   price: 150,  purchase: 120 },
  { name: 'Coca-Cola 500ml',  category: 'Beverages',   price: 70,   purchase: 55  },
  { name: 'Lipton Tea 500g',  category: 'Groceries',   price: 680,  purchase: 560 },
  { name: 'Dettol Soap',      category: 'Personal Care', price: 120, purchase: 95 },
  { name: 'Shan Masala',      category: 'Groceries',   price: 95,   purchase: 75  },
  { name: 'Nestle Milk 1L',   category: 'Dairy',       price: 260,  purchase: 220 },
  { name: 'Sunsilk Shampoo',  category: 'Personal Care', price: 300, purchase: 245 },
  { name: 'Lays Chips',       category: 'Snacks',      price: 50,   purchase: 38  },
  { name: 'Ariel Detergent',  category: 'Household',   price: 450,  purchase: 370 },
  { name: 'Colgate Paste',    category: 'Personal Care', price: 175, purchase: 140 },
  { name: 'Whole Wheat Bread',category: 'Bakery',      price: 140,  purchase: 110 },
  { name: 'Basmati Rice 5kg', category: 'Groceries',   price: 1800, purchase: 1550},
  { name: 'Sunflower Oil 1L', category: 'Groceries',   price: 480,  purchase: 400 },
  { name: 'Sprite 1.5L',      category: 'Beverages',   price: 150,  purchase: 120 },
  { name: 'Fair & Lovely',    category: 'Personal Care', price: 250, purchase: 200 },
];

const PAYMENT_METHODS = ['cash', 'card', 'online', 'upi'];

console.log('\n╔══════════════════════════════════════════╗');
console.log('║   OsaTech POS Cloud — Demo Seed           ║');
console.log('╚══════════════════════════════════════════╝\n');

// ─── 1. Insert instances ───────────────────────────────────────────────────────
console.log('Step 1/4 — Creating demo instances…');
const instanceRows: Array<{ instanceId: string; store: typeof STORES[0] }> = [];

for (const store of STORES) {
  const instanceId = `demo_${store.mobile}`;
  const apiKey     = `ak_demo_${crypto.randomBytes(16).toString('hex')}`;
  const licenseKey = store.plan !== 'none' ? genKey(store.name, store.plan, store.days) : '';
  const expiry     = store.plan !== 'none' && store.days > 0
    ? new Date(Date.now() + store.days * 86_400_000).toISOString()
    : null;
  const lastSeen   = store.status === 'approved' ? hoursAgo(rnd(1, store.daysAgo * 24 + 2)) : (store.status === 'pending' ? hoursAgo(rnd(0, 2)) : daysAgo(store.daysAgo));

  const totalProducts = store.status === 'approved' ? PRODUCTS.length : 0;
  const totalCustomers = store.status === 'approved' ? rnd(10, 60) : 0;
  const totalSales     = store.status === 'approved' ? rnd(30, 200) : 0;
  const totalRevenue   = totalSales * rnd(400, 1500);

  try {
    db.prepare(`
      INSERT OR IGNORE INTO instances
        (instance_id, store_name, owner_name, owner_mobile, business_name,
         api_key, license_key, license_plan, license_expiry,
         approval_status, block_reason, last_seen,
         total_sales, total_revenue, total_customers, total_products,
         created_at, updated_at)
      VALUES (?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?,?, datetime('now',?), datetime('now',?))
    `).run(
      instanceId, store.name, store.owner, store.mobile, store.name,
      apiKey, licenseKey, store.plan, expiry,
      store.status, store.status === 'blocked' ? 'License expired — not renewed' : '', lastSeen,
      totalSales, totalRevenue, totalCustomers, totalProducts,
      `-${store.daysAgo} days`, `-${store.daysAgo} days`,
    );
    instanceRows.push({ instanceId, store });
    process.stdout.write(`  ✓ ${store.name} [${store.status}]\n`);
  } catch (e: any) {
    process.stdout.write(`  ↳ Already exists: ${store.name}\n`);
    instanceRows.push({ instanceId, store });
  }
}

// ─── 2. Insert instance_sales for approved instances ─────────────────────────
console.log('\nStep 2/4 — Seeding sales data (last 90 days)…');
let totalSalesInserted = 0;

const insertSale = db.prepare(`
  INSERT OR IGNORE INTO instance_sales
    (instance_id, pos_sale_id, total, discount, payment_method, payment_status,
     status, items_count, items_summary, date_created)
  VALUES (?,?,?,?,?,?,?,?,?,?)
`);

for (const { instanceId, store } of instanceRows) {
  if (store.status !== 'approved') continue;

  const salesPerStore = rnd(60, 150);
  let posId = rnd(1000, 9999);

  for (let i = 0; i < salesPerStore; i++) {
    posId++;
    const numItems = rnd(1, 5);
    let total = 0;
    const itemParts: string[] = [];
    for (let j = 0; j < numItems; j++) {
      const p = PRODUCTS[rnd(0, PRODUCTS.length - 1)];
      const qty = rnd(1, 4);
      total += p.price * qty;
      itemParts.push(`${p.name} (x${qty})`);
    }
    const discount = Math.random() > 0.85 ? Math.floor(total * rnd(5, 15) / 100) : 0;
    const finalTotal = total - discount;
    const dateStr = randDate(90);
    const payMethod = PAYMENT_METHODS[rnd(0, PAYMENT_METHODS.length - 1)];

    try {
      insertSale.run(
        instanceId, posId, finalTotal, discount, payMethod,
        'Paid', 'Completed', numItems, itemParts.join(', '), dateStr,
      );
      totalSalesInserted++;
    } catch { /* ignore duplicate */ }
  }
}
console.log(`  ✓ ${totalSalesInserted} sale records inserted`);

// ─── 3. Insert sync_events (products, customers) ─────────────────────────────
console.log('\nStep 3/4 — Seeding sync events (products & customers)…');
let syncEventsInserted = 0;

const insertEvent = db.prepare(`
  INSERT INTO sync_events (instance_id, entity_type, operation, payload, received_at)
  VALUES (?,?,?,?,?)
`);

for (const { instanceId, store } of instanceRows) {
  if (store.status !== 'approved') continue;

  // Products
  for (let i = 0; i < PRODUCTS.length; i++) {
    const p = PRODUCTS[i];
    const payload = JSON.stringify({
      id: i + 1, name: p.name, category: p.category,
      price: p.price, purchase_price: p.purchase,
      stock: rnd(10, 500), barcode: `89${i}${instanceId.slice(-4)}`,
    });
    try {
      insertEvent.run(instanceId, 'product', 'create', payload, daysAgo(rnd(30, 90)));
      syncEventsInserted++;
    } catch { /* ignore */ }
  }

  // Customers
  const custNames = ['Ali Raza', 'Fatima Malik', 'Zain Ahmed', 'Sara Khan', 'Omar Sheikh',
                     'Hina Butt', 'Waqas Noor', 'Nadia Iqbal', 'Hamza Qureshi', 'Ayesha Tariq'];
  for (let i = 0; i < custNames.length; i++) {
    const payload = JSON.stringify({
      id: i + 1, name: custNames[i],
      phone: `0300${rnd(1000000, 9999999)}`,
      balance: rnd(0, 5000),
    });
    try {
      insertEvent.run(instanceId, 'customer', 'create', payload, daysAgo(rnd(10, 60)));
      syncEventsInserted++;
    } catch { /* ignore */ }
  }
}
console.log(`  ✓ ${syncEventsInserted} sync events inserted`);

// ─── 4. Summary ──────────────────────────────────────────────────────────────
console.log('\nStep 4/4 — Counting final totals…');
const instCount  = (db.prepare('SELECT COUNT(*) as c FROM instances').get() as any).c;
const salesCount = (db.prepare('SELECT COUNT(*) as c FROM instance_sales').get() as any).c;
const syncCount  = (db.prepare('SELECT COUNT(*) as c FROM sync_events').get() as any).c;

console.log(`\n✅  Cloud seed complete!`);
console.log(`   Instances     : ${instCount}`);
console.log(`   Sales records : ${salesCount}`);
console.log(`   Sync events   : ${syncCount}`);
console.log(`\n   You can now log in to the admin dashboard to see the data.\n`);
