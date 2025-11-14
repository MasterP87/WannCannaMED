// scripts/run-migrations.js
const path = require('path');
const { ensureProductsSchema } = require('../db/migrations/ensure-products-schema');

(async () => {
  try {
    const DB_PATH = process.env.DB_PATH || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'data.db');
    const result = await ensureProductsSchema(DB_PATH);
    console.log('[migrate] products table ok:', result);
    process.exit(0);
  } catch (err) {
    console.error('[migrate] failed:', err);
    process.exit(1);
  }
})();