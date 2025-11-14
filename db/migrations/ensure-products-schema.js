// db/migrations/ensure-products-schema.js
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const EXPECTED_COLUMNS = [
  { name: 'title',       ddl: "TEXT" },
  { name: 'price',       ddl: "REAL" },
  { name: 'image',       ddl: "TEXT" },
  { name: 'description', ddl: "TEXT" },
  { name: 'thc',         ddl: "TEXT" },
  { name: 'cbd',         ddl: "TEXT" },
  { name: 'effects',     ddl: "TEXT" },
  { name: 'aroma',       ddl: "TEXT" },
  { name: 'terpenes',    ddl: "TEXT" },
  { name: 'strain_type', ddl: "TEXT" },
  { name: 'is_active',   ddl: "INTEGER DEFAULT 1" },
  { name: 'created_at',  ddl: "DATETIME DEFAULT CURRENT_TIMESTAMP" },
  { name: 'updated_at',  ddl: "DATETIME DEFAULT CURRENT_TIMESTAMP" }
];

function query(db, sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
}

function run(db, sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

async function ensureTable(db) {
  const rows = await query(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='products'");
  if (rows.length === 0) {
    const cols = [
      "id INTEGER PRIMARY KEY AUTOINCREMENT",
      ...EXPECTED_COLUMNS.map(c => `${c.name} ${c.ddl}`)
    ];
    await run(db, `CREATE TABLE products (${cols.join(', ')})`);
    return { created: true, added: [] };
  }
  const info = await query(db, "PRAGMA table_info(products)");
  const have = new Set(info.map(r => r.name));
  const missing = EXPECTED_COLUMNS.filter(c => !have.has(c.name));
  const added = [];
  for (const col of missing) {
    await run(db, `ALTER TABLE products ADD COLUMN ${col.name} ${col.ddl}`);
    added.push(col.name);
  }
  return { created: false, added };
}

async function ensureProductsSchema(dbOrPath) {
  let db = dbOrPath;
  let opened = false;
  if (!(dbOrPath && typeof dbOrPath.all === 'function')) {
    const DB_PATH = dbOrPath || process.env.DB_PATH || path.join(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'data.db');
    const DATA_DIR = path.dirname(DB_PATH);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new sqlite3.Database(DB_PATH);
    opened = true;
  }
  try {
    await run(db, "PRAGMA journal_mode=WAL");
    await run(db, "PRAGMA foreign_keys=ON");
    const result = await ensureTable(db);
    return result;
  } finally {
    if (opened && db) db.close();
  }
}

module.exports = { ensureProductsSchema };