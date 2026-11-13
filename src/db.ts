import { PrismaClient } from '@prisma/client';

// instance_sales.pos_sale_id is BIGINT; Prisma returns bigint, which res.json() cannot
// serialise. POS ids stay below 2^53, so Number is lossless.
(BigInt.prototype as any).toJSON = function toJSON(this: bigint) { return Number(this); };

// Singleton pattern — reuse the same client across hot reloads in dev
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

const prisma = global.__prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

if (process.env.NODE_ENV !== 'production') {
  global.__prisma = prisma;
}

export default prisma;
