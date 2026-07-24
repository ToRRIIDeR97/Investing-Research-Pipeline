import postgres from "postgres";
async function main() {
  const sql = postgres(process.env.DATABASE_URL!);
  try {
    await sql`DELETE FROM assets WHERE slug = 'test-co-artifacts'`;
    console.log("ok");
  } finally {
    await sql.end();
  }
}
main();
