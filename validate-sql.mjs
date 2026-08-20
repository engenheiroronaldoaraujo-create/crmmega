import { parse } from 'libpg-query';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'supabase/migrations';
const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

let hadError = false;
let totalStmts = 0;

for (const file of files) {
  const sql = readFileSync(join(dir, file), 'utf8');
  try {
    const result = await parse(sql);
    const stmtCount = result.stmts?.length ?? 0;
    totalStmts += stmtCount;
    console.log(`OK   ${file}   (${stmtCount} statements)`);
  } catch (err) {
    hadError = true;
    console.error(`FAIL ${file}`);
    console.error(`     ${err.message}`);
    if (err.cursorPosition !== undefined) {
      const lines = sql.slice(0, err.cursorPosition).split('\n');
      console.error(`     at line ${lines.length}, col ${lines[lines.length - 1].length + 1}`);
    }
  }
}

console.log(`\n${files.length} files parsed · ${totalStmts} statements total`);
process.exit(hadError ? 1 : 0);
