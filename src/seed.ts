/**
 * Seed script — creates the first admin user.
 * Run: npm run seed:admin
 *
 * Reads username and password from CLI args:
 *   ts-node src/seed.ts myAdmin myPassword123
 *
 * Falls back to defaults if not provided:
 *   username: admin
 *   password: osatech@2025
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import db from './db';

async function seed() {
  const args = process.argv.slice(2);
  const username = (args[0] || 'admin').trim().toLowerCase();
  const password = args[1] || 'osatech@2025';

  if (password.length < 6) {
    console.error('❌  Password must be at least 6 characters');
    process.exit(1);
  }

  const existing = db
    .prepare('SELECT id FROM admin_users WHERE username = ?')
    .get(username);

  if (existing) {
    console.log(`⚠️  Admin "${username}" already exists. Nothing changed.`);
    process.exit(0);
  }

  const hash = await bcrypt.hash(password, 12);
  db.prepare("INSERT INTO admin_users (username, password_hash, role) VALUES (?, ?, 'super_admin')")
    .run(username, hash);

  console.log(`\n✅  Admin created successfully`);
  console.log(`   Username : ${username}`);
  console.log(`   Password : ${password}`);
  console.log(`\n   Login at : POST /api/auth/login\n`);
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
