import 'dotenv/config';
import { connectDb, disconnectDb } from '../server/db.js';
import { ensureSharedCustomerTenant } from '../server/tenant-seed.js';

async function main() {
  await connectDb();
  const t = await ensureSharedCustomerTenant();
  console.log('[seed] shared customer tenant', JSON.stringify(t, null, 2));
  await disconnectDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
