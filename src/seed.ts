/**
 * Seed script — creates the first admin user.
 * Run: npm run seed:admin
 *
 * Usage:
 *   ts-node src/seed.ts [username] [password]
 *
 * Defaults: username=admin  password=osatech@2025
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import prisma from './db';

async function seed() {
  const args     = process.argv.slice(2);
  const username = (args[0] || 'admin').trim().toLowerCase();
  const password = args[1] || 'osatech@2025';

  if (password.length < 6) {
    console.error('❌  Password must be at least 6 characters');
    process.exit(1);
  }

  const existing = await prisma.adminUser.findUnique({ where: { username } });

  if (existing) {
    console.log(`⚠️  Admin "${username}" already exists. Nothing changed.`);
    await prisma.$disconnect();
    process.exit(0);
  }

  const hash = await bcrypt.hash(password, 12);
  await prisma.adminUser.create({
    data: { username, password_hash: hash, role: 'super_admin' },
  });

  console.log(`\n✅  Admin created successfully`);
  console.log(`   Username : ${username}`);
  console.log(`   Password : ${password}`);
  console.log(`\n   Login at : POST /api/auth/login\n`);

  await prisma.$disconnect();
}

seed().catch(async (err) => {
  console.error('Seed failed:', err);
  await prisma.$disconnect();
  process.exit(1);
});
