/** SQL-owned security tables need the same owner-scoped export/erasure policy. */
const runtimeTables = new Map([
  ["privacy_jobs", "to_jsonb(r)-'public_key'-'object_key'"],
  ["privacy_erased_accounts", "to_jsonb(r)"],
  ["login_security_activity", "to_jsonb(r)"],
  ["login_trusted_locations", "to_jsonb(r)"],
]);
export async function runtimeUserRecords(db: any,userId: string,knownTables: string[]) {
  const columns: { table_name:string }[] = await db.$queryRaw`SELECT table_name FROM information_schema.columns WHERE table_schema=current_schema() AND column_name='user_id'`;
  const result: Record<string,any[]> = {};
  for (const { table_name:table } of columns) {
    if (knownTables.includes(table)) continue;
    const projection = runtimeTables.get(table);
    if (!projection) throw new Error("Unclassified user-data table requires an export policy");
    // Identifiers/projections come exclusively from the static server allowlist.
    const rows: { data:any }[] = await db.$queryRawUnsafe(`SELECT ${projection} AS data FROM "${table}" r WHERE user_id=$1 LIMIT 50001`,userId);
    if (rows.length>50000) throw new Error("Export requires operator assistance");
    result[table]=rows.map(row=>row.data);
  }
  return result;
}
export async function eraseRuntimeSecurityRecords(db:any,userId:string) {
  for(const table of ["login_security_activity","login_trusted_locations"]) {
    const found: { present:boolean }[]=await db.$queryRawUnsafe("SELECT to_regclass($1) IS NOT NULL AS present",table);
    if(found[0].present) await db.$executeRawUnsafe(`DELETE FROM "${table}" WHERE user_id=$1`,userId);
  }
}
