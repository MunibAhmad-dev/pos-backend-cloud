/**
 * Cloud backend demo seed — Prisma version
 * Creates realistic demo instances, sales, products and sync events.
 *
 * Usage:  npx ts-node src/seed-cloud.ts
 *         npm run seed:cloud
 *
 * Safe to re-run — upserts instances (skipDuplicates on sales/events).
 */

import 'dotenv/config';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import prisma from './db';

// ─── License generator ────────────────────────────────────────────────────────
const LICENSE_SECRET = Buffer.from(
  '4a616e75617279203173742c2032303236204c6963656e736520536563726574',
  'hex',
);
const IV_LENGTH = 12;

function genKey(issuedTo: string, plan: string, days: number): string {
  const now = new Date();
  const exp = new Date(now.getTime() + days * 86_400_000);
  const payload = JSON.stringify({
    id: uuidv4(), issuedTo, issuedForFingerprint: '',
    durationDays: days, maxDevices: 1,
    issuedAt: now.toISOString(), expiresAt: exp.toISOString(),
  });
  const iv     = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', LICENSE_SECRET, iv);
  let enc = cipher.update(payload, 'utf8', 'hex');
  enc += cipher.final('hex');
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const rnd = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const daysAgoDate  = (n: number)  => new Date(Date.now() - n * 86_400_000);
const hoursAgoDate = (n: number)  => new Date(Date.now() - n * 3_600_000);
const randDateStr  = (daysBack: number) =>
  new Date(Date.now() - rnd(0, daysBack * 86_400_000)).toISOString().replace('T', ' ').slice(0, 19);

// ─── Demo data ────────────────────────────────────────────────────────────────
const STORES = [
  { name: 'Khan General Store',  owner: 'Bilal Khan',    mobile: '03001234567', plan: 'yearly',    days: 365, status: 'approved', daysOld: 0  },
  { name: 'City Mart',           owner: 'Usman Raza',    mobile: '03111234567', plan: 'monthly',   days: 30,  status: 'approved', daysOld: 2  },
  { name: 'Al-Baraka Traders',   owner: 'Asim Nawaz',    mobile: '03211234567', plan: 'quarterly', days: 90,  status: 'approved', daysOld: 1  },
  { name: 'Metro Mini Market',   owner: 'Farhan Ahmed',  mobile: '03311234567', plan: 'monthly',   days: 30,  status: 'approved', daysOld: 5  },
  { name: 'Hafeez Mart',         owner: 'Hafeez Ullah',  mobile: '03451234567', plan: 'yearly',    days: 365, status: 'approved', daysOld: 8  },
  { name: 'Sunrise Store',       owner: 'Naveed Iqbal',  mobile: '03001119876', plan: 'none',      days: 0,   status: 'pending',  daysOld: 0  },
  { name: 'Green Valley Shop',   owner: 'Kamran Malik',  mobile: '03121119876', plan: 'none',      days: 0,   status: 'pending',  daysOld: 0  },
  { name: 'Old Spice Traders',   owner: 'Tariq Javed',   mobile: '03221119876', plan: 'none',      days: 0,   status: 'blocked',  daysOld: 30 },
];

const PRODUCTS = [
  { name: 'Pepsi 1.5L',        category: 'Beverages',    price: 150,  purchase: 120  },
  { name: 'Coca-Cola 500ml',   category: 'Beverages',    price: 70,   purchase: 55   },
  { name: 'Lipton Tea 500g',   category: 'Groceries',    price: 680,  purchase: 560  },
  { name: 'Dettol Soap',       category: 'Personal Care', price: 120, purchase: 95   },
  { name: 'Shan Masala',       category: 'Groceries',    price: 95,   purchase: 75   },
  { name: 'Nestle Milk 1L',    category: 'Dairy',        price: 260,  purchase: 220  },
  { name: 'Sunsilk Shampoo',   category: 'Personal Care', price: 300, purchase: 245  },
  { name: 'Lays Chips',        category: 'Snacks',       price: 50,   purchase: 38   },
  { name: 'Ariel Detergent',   category: 'Household',    price: 450,  purchase: 370  },
  { name: 'Colgate Paste',     category: 'Personal Care', price: 175, purchase: 140  },
  { name: 'Whole Wheat Bread', category: 'Bakery',       price: 140,  purchase: 110  },
  { name: 'Basmati Rice 5kg',  category: 'Groceries',    price: 1800, purchase: 1550 },
  { name: 'Sunflower Oil 1L',  category: 'Groceries',    price: 480,  purchase: 400  },
  { name: 'Sprite 1.5L',       category: 'Beverages',    price: 150,  purchase: 120  },
  { name: "Fair & Lovely",     category: 'Personal Care', price: 250, purchase: 200  },
];

const PAYMENT_METHODS = ['cash', 'card', 'online', 'upi'];
const CUST_NAMES      = ['Ali Raza', 'Fatima Malik', 'Zain Ahmed', 'Sara Khan', 'Omar Sheikh',
                          'Hina Butt', 'Waqas Noor', 'Nadia Iqbal', 'Hamza Qureshi', 'Ayesha Tariq'];

// ─── Main ─────────────────────────────────────────────────────────────────────
async function seed() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   OsaTech POS Cloud — Demo Seed           ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // Step 1 — Instances
  console.log('Step 1/4 — Creating demo instances…');
  const instanceRows: Array<{ instanceId: string; store: typeof STORES[0] }> = [];

  for (const store of STORES) {
    const instanceId = `demo_${store.mobile}`;
    const apiKey     = `ak_demo_${crypto.randomBytes(16).toString('hex')}`;
    const licenseKey = store.plan !== 'none' ? genKey(store.name, store.plan, store.days) : '';
    const expiry     = store.plan !== 'none' && store.days > 0
      ? new Date(Date.now() + store.days * 86_400_000).toISOString() : null;
    const lastSeen   = store.status === 'approved' ? hoursAgoDate(rnd(1, store.daysOld * 24 + 2))
                     : store.status === 'pending'  ? hoursAgoDate(rnd(0, 2))
                     : daysAgoDate(store.daysOld);
    const totalSales    = store.status === 'approved' ? rnd(30, 200) : 0;
    const totalRevenue  = totalSales * rnd(400, 1500);

    await prisma.instance.upsert({
      where:  { instance_id: instanceId },
      create: {
        instance_id:     instanceId,
        store_name:      store.name,
        owner_name:      store.owner,
        owner_mobile:    store.mobile,
        business_name:   store.name,
        api_key:         apiKey,
        license_key:     licenseKey,
        license_plan:    store.plan,
        license_expiry:  expiry,
        approval_status: store.status,
        block_reason:    store.status === 'blocked' ? 'License expired — not renewed' : '',
        last_seen:       lastSeen,
        total_sales:     totalSales,
        total_revenue:   totalRevenue,
        total_customers: store.status === 'approved' ? rnd(10, 60) : 0,
        total_products:  store.status === 'approved' ? PRODUCTS.length : 0,
        created_at:      daysAgoDate(store.daysOld),
      },
      update: {},   // skip if already exists
    });
    instanceRows.push({ instanceId, store });
    process.stdout.write(`  ✓ ${store.name} [${store.status}]\n`);
  }

  // Step 2 — Sales
  console.log('\nStep 2/4 — Seeding sales data (last 90 days)…');
  let totalSalesInserted = 0;

  for (const { instanceId, store } of instanceRows) {
    if (store.status !== 'approved') continue;

    const salesPerStore = rnd(60, 150);
    let posId = rnd(1000, 9999);
    const salesData: any[] = [];

    for (let i = 0; i < salesPerStore; i++) {
      posId++;
      const numItems = rnd(1, 5);
      let total = 0;
      const parts: string[] = [];
      for (let j = 0; j < numItems; j++) {
        const p   = PRODUCTS[rnd(0, PRODUCTS.length - 1)];
        const qty = rnd(1, 4);
        total += p.price * qty;
        parts.push(`${p.name} (x${qty})`);
      }
      const discount = Math.random() > 0.85 ? Math.floor(total * rnd(5, 15) / 100) : 0;
      salesData.push({
        instance_id:    instanceId,
        pos_sale_id:    posId,
        total:          total - discount,
        discount,
        payment_method: PAYMENT_METHODS[rnd(0, PAYMENT_METHODS.length - 1)],
        payment_status: 'Paid',
        status:         'Completed',
        items_count:    numItems,
        items_summary:  parts.join(', '),
        date_created:   randDateStr(90),
      });
    }

    const result = await prisma.instanceSale.createMany({ data: salesData, skipDuplicates: true });
    totalSalesInserted += result.count;
  }
  console.log(`  ✓ ${totalSalesInserted} sale records inserted`);

  // Step 3 — Sync events
  console.log('\nStep 3/4 — Seeding sync events (products & customers)…');
  let syncEventsInserted = 0;

  for (const { instanceId, store } of instanceRows) {
    if (store.status !== 'approved') continue;

    const eventsData: any[] = [];

    // Products
    PRODUCTS.forEach((p, i) => {
      eventsData.push({
        instance_id: instanceId,
        entity_type: 'product',
        operation:   'create',
        payload:     JSON.stringify({ id: i + 1, name: p.name, category: p.category, price: p.price, purchase_price: p.purchase, stock: rnd(10, 500), barcode: `89${i}${instanceId.slice(-4)}` }),
        received_at: daysAgoDate(rnd(30, 90)),
      });
    });

    // Customers
    CUST_NAMES.forEach((name, i) => {
      eventsData.push({
        instance_id: instanceId,
        entity_type: 'customer',
        operation:   'create',
        payload:     JSON.stringify({ id: i + 1, name, phone: `0300${rnd(1000000, 9999999)}`, balance: rnd(0, 5000) }),
        received_at: daysAgoDate(rnd(10, 60)),
      });
    });

    const result = await prisma.syncEvent.createMany({ data: eventsData });
    syncEventsInserted += result.count;
  }
  console.log(`  ✓ ${syncEventsInserted} sync events inserted`);

  // Step 4 — Summary
  console.log('\nStep 4/4 — Counting final totals…');
  const [instCount, salesCount, syncCount] = await Promise.all([
    prisma.instance.count(),
    prisma.instanceSale.count(),
    prisma.syncEvent.count(),
  ]);

  console.log(`\n✅  Cloud seed complete!`);
  console.log(`   Instances     : ${instCount}`);
  console.log(`   Sales records : ${salesCount}`);
  console.log(`   Sync events   : ${syncCount}`);
  console.log(`\n   You can now log in to the admin dashboard to see the data.\n`);
}

seed()
  .catch((err) => { console.error('Seed failed:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
