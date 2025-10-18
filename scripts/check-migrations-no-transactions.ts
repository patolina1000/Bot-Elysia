import fs from "fs";
import path from "path";

const migrationsDir = path.resolve(__dirname, "../src/db/migrations");

function hasNestedTransaction(sql: string) {
  const transactionTokens = [/\bBEGIN\s*;/i, /\bCOMMIT\s*;/i, /\bROLLBACK\s*;/i];
  return transactionTokens.some((regex) => regex.test(sql));
}

function main() {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  const offenders: string[] = [];

  for (const file of files) {
    const fullPath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(fullPath, "utf8");
    if (hasNestedTransaction(sql)) {
      offenders.push(file);
    }
  }

  if (offenders.length > 0) {
    console.error(
      "The following migrations contain explicit transaction statements (BEGIN/COMMIT/ROLLBACK):"
    );
    for (const file of offenders) {
      console.error(` - ${file}`);
    }
    console.error(
      "Migration runner already wraps each migration in a transaction. Remove the nested statements above."
    );
    process.exit(1);
  }

  console.log("All migrations are free from nested transaction statements.");
}

main();
