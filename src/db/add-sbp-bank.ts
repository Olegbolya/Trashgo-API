import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);

try {
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS sbp_bank VARCHAR(100)`;
  console.log('✓ Column sbp_bank added');
} catch (e: any) {
  console.error('Error:', e.message);
} finally {
  await sql.end();
  process.exit(0);
}
