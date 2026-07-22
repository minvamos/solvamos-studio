/**
 * Prisma client singleton — platform DB (PostgreSQL).
 * Mutable business data only. Infra secrets stay in env / Secret Manager.
 */
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.PRISMA_LOG === 'true' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export async function connectDb(): Promise<void> {
  await prisma.$connect();
  console.log('[db] PostgreSQL connected');
}

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}
