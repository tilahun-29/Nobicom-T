"use strict";
// Safe online backup of the help desk database.
// Usage: node scripts/backup.js [folder]      (default folder: ./backups)
// Keeps the 30 newest backups in that folder.
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const dbPath = process.env.DB_PATH || path.join(__dirname, "..", "data", "helpdesk.db");
const dir = path.resolve(process.argv[2] || path.join(__dirname, "..", "backups"));
if (!fs.existsSync(dbPath)) { console.error("Database not found at " + dbPath); process.exit(1); }
fs.mkdirSync(dir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
const target = path.join(dir, `helpdesk-${stamp}.db`);
const db = new DatabaseSync(dbPath);
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();
console.log("Backup written to " + target);

const old = fs.readdirSync(dir).filter((f) => /^helpdesk-.*\.db$/.test(f)).sort().reverse().slice(30);
old.forEach((f) => fs.unlinkSync(path.join(dir, f)));
