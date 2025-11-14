HOTFIX – Migration für SQLite-Tabelle 'products'

Fehler im Log:
  SQLITE_ERROR: table products has no column named thc

Lösung:
  Dieses Paket ergänzt fehlende Spalten (thc, cbd, effects, aroma, terpenes, strain_type, usw.)
  oder legt die Tabelle neu an, falls sie fehlt. Idempotent – kann bei jedem Start laufen.

Ordner/Dateien:
  - db/migrations/ensure-products-schema.js
  - scripts/run-migrations.js
  - README-HOTFIX.txt

Variante A (automatisch bei jedem Start; empfohlen):
  In server.js NACH dem Öffnen der DB (db = new sqlite3.Database(...)) einfügen:
    const { ensureProductsSchema } = require('./db/migrations/ensure-products-schema');
    ensureProductsSchema(db).then(r => console.log('[schema]', r)).catch(console.error);
  WICHTIG: Vor dem Seed/Einfügen der Sorten ausführen.

Variante B (einmalig per Shell ausführen):
  1) Dateien ins Repo kopieren (Ordnerstruktur beibehalten).
  2) In Render-Shell:
       node scripts/run-migrations.js
  3) Danach Rebuild/Restart.