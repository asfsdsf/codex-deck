import "reflect-metadata";

// Patch crypto.subtle.importKey to normalize base64 → base64url in JWK data.
// privacy-kit uses standard base64 for Ed25519 JWK keys, but Bun (correctly per spec)
// requires base64url. Node.js is lenient about this, Bun is not.
const origImportKey = crypto.subtle.importKey.bind(crypto.subtle);
crypto.subtle.importKey = function (
  format: any,
  keyData: any,
  algorithm: any,
  extractable: any,
  keyUsages: any,
) {
  if (format === "jwk" && keyData && typeof keyData === "object") {
    const fixed = { ...keyData };
    for (const field of [
      "d",
      "x",
      "y",
      "n",
      "e",
      "p",
      "q",
      "dp",
      "dq",
      "qi",
      "k",
    ]) {
      if (typeof fixed[field] === "string") {
        fixed[field] = fixed[field]
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
      }
    }
    return origImportKey(format, fixed, algorithm, extractable, keyUsages);
  }
  return origImportKey(format, keyData, algorithm, extractable, keyUsages);
} as any;

import * as fs from "fs";
import * as path from "path";
import { createPGlite } from "./storage/pgliteLoader";

const dataDir = process.env.DATA_DIR || "./data";
const pgliteDir = process.env.PGLITE_DIR || path.join(dataDir, "pglite");
const SCHEMA_VERSION = 1;
const SCHEMA_STATE_TABLE = "_codexdeck_schema_state";

function resolveInitSqlPath(): string | null {
  const candidates = [
    path.join(process.cwd(), "prisma", "init.sql"),
    path.join(path.dirname(process.execPath), "prisma", "init.sql"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function init() {
  console.log(`Initializing database schema in ${pgliteDir}...`);
  fs.mkdirSync(pgliteDir, { recursive: true });

  const pg = createPGlite(pgliteDir);

  // Track whether the bootstrap schema has already been applied.
  await pg.exec(`
        CREATE TABLE IF NOT EXISTS "${SCHEMA_STATE_TABLE}" (
            "version" INTEGER PRIMARY KEY,
            "applied_at" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);

  const applied = await pg.query<{ version: number }>(
    `SELECT "version" FROM "${SCHEMA_STATE_TABLE}" WHERE "version" = $1`,
    [SCHEMA_VERSION],
  );
  if (applied.rows.length > 0) {
    console.log("Schema already initialized.");
    await pg.close();
    return;
  }

  const initSqlPath = resolveInitSqlPath();
  if (!initSqlPath) {
    console.error("Could not find prisma/init.sql");
    process.exit(1);
  }

  const sql = fs.readFileSync(initSqlPath, "utf-8");
  console.log(
    `  Applying schema bootstrap from ${path.basename(initSqlPath)}...`,
  );
  try {
    await pg.exec(sql);
    await pg.query(
      `INSERT INTO "${SCHEMA_STATE_TABLE}" ("version") VALUES ($1)`,
      [SCHEMA_VERSION],
    );
  } catch (e: any) {
    console.error(`  Failed to initialize schema: ${e.message}`);
    process.exit(1);
  }

  console.log("Schema initialized.");
  await pg.close();
}

async function serve() {
  // Set PGLITE_DIR so db.ts picks it up
  if (!process.env.DATABASE_URL) {
    process.env.PGLITE_DIR = process.env.PGLITE_DIR || pgliteDir;
  }

  // Import and run the main server
  await import("./main");
}

// CLI
const command = process.argv[2];

switch (command) {
  case "init":
    init().catch((e) => {
      console.error(e);
      process.exit(1);
    });
    break;
  case "serve":
    serve().catch((e) => {
      console.error(e);
      process.exit(1);
    });
    break;
  default:
    console.log(`codexdeck-server - portable distribution

Usage:
  codexdeck-server init       Initialize the database schema
  codexdeck-server serve      Start the server

Environment variables:
  DATA_DIR          Base data directory (default: ./data)
  PGLITE_DIR        PGlite database directory (default: DATA_DIR/pglite)
  DATABASE_URL      PostgreSQL URL (if set, uses external Postgres instead of PGlite)
  REDIS_URL         Redis URL (optional, not required for standalone)
  PORT              Server port (default: 3005)
  CODEXDECK_REMOTE_ADMIN_PASSWORD  Required: admin password for /admin
  CODEXDECK_REMOTE_SETUP_TOKENS    Optional: initial CLI setup tokens to seed on first boot
  CODEXDECK_TOKEN_SIGNING_SECRET   Optional: overrides generated token-signing secret
  CODEXDECK_SERVER_ENCRYPTION_SECRET Optional: overrides generated server encryption secret
`);
    process.exit(command === "--help" || command === "-h" ? 0 : 1);
}
