require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcrypt');
const csrf = require('csurf');
const helmet = require('helmet');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust the first proxy.  This is important when deploying behind a
// reverse proxy (such as on Render) so that secure cookies work properly.
app.set('trust proxy', 1);

// Configure persistent directories.  When deploying to platforms like Render,
// you should mount a persistent disk at `/data` and set the environment
// variables below so that all database, session and upload files survive
// container restarts.  Defaults fall back to the project directory for
// local development.
const DATA_DIR    = process.env.DATA_DIR    || __dirname;
const DB_PATH     = process.env.DB_PATH     || path.join(DATA_DIR, 'data.db');
const SESSION_DIR = process.env.SESSION_DIR || DATA_DIR;
const UPLOAD_DIR  = process.env.UPLOAD_DIR  || path.join(DATA_DIR, 'uploads');

// Ensure the upload directory exists.  Without this call multer will fail
// if the directory is missing on first upload.
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Open the SQLite database at the configured path.  The file will be
// created automatically if it does not exist.  Note that using DATA_DIR
// ensures the DB file is stored on a persistent volume when configured.
const db = new sqlite3.Database(DB_PATH);

// Configure file upload for product images using multer. Images are stored
// in the public/images directory. Filenames are generated uniquely to
// avoid collisions. Only basic filtering is done here; additional
// validation can be added if necessary.
const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'public/images'));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + ext);
  }
});
const upload = multer({ storage: imageStorage });

// Create tables if they do not exist. Using SERIALIZE ensures the
// statements run sequentially.
db.serialize(() => {
  // Create the users table with extended fields. In older deployments the
  // table may already exist without some of these columns; they will be
  // added later by extendUserSchema(). New installations get the full
  // schema immediately.
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    email TEXT UNIQUE,
    phone TEXT,
    password_hash TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    approved INTEGER DEFAULT 0,
    newsletter_opt_in INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    price REAL NOT NULL,
    image TEXT NOT NULL
    -- Additional columns for cannabis metadata will be added at runtime
  )`);
});

// Extend the products table with additional fields if they do not already exist.
function extendProductSchema() {
  /*
   * Dynamically extend the products table with additional metadata
   * columns if they do not already exist. We query the existing
   * column names via PRAGMA and then run ALTER TABLE statements
   * with a DEFAULT value to ensure existing rows receive empty
   * strings. Without the DEFAULT, older rows would store NULL
   * values and subsequent queries might fail when reading the data.
   */
  const desiredColumns = ['thc', 'cbd', 'effects', 'aroma', 'terpenes'];
  db.all('PRAGMA table_info(products)', (err, rows) => {
    if (err) {
      console.error('Error reading table info', err.message);
      return;
    }
    const existing = rows.map(r => r.name);
    desiredColumns.forEach(col => {
      if (!existing.includes(col)) {
        db.run(
          `ALTER TABLE products ADD COLUMN ${col} TEXT DEFAULT ''`,
          [],
          err2 => {
            if (err2 && !/duplicate column name/i.test(err2.message)) {
              console.error('Error adding column', col, err2.message);
            }
          }
        );
      }
    });
  });
}

// Call the schema extension function after tables are created.
extendProductSchema();

// Extend the users table with additional columns if they do not already exist.  When the
// schema is upgraded, this function inspects the current column names via PRAGMA
// and adds the missing ones.  'username' and 'phone' are TEXT columns, while
// 'newsletter_opt_in' is an INTEGER with a default of 0 (false).
function extendUserSchema() {
  const desiredColumns = ['username', 'phone', 'newsletter_opt_in'];
  db.all('PRAGMA table_info(users)', (err, rows) => {
    if (err) {
      console.error('Error reading users table info', err.message);
      return;
    }
    const existing = rows.map(r => r.name);
    desiredColumns.forEach(col => {
      if (!existing.includes(col)) {
        let type = 'TEXT';
        if (col === 'newsletter_opt_in') type = 'INTEGER DEFAULT 0';
        db.run(
          `ALTER TABLE users ADD COLUMN ${col} ${type}`,
          [],
          err2 => {
            if (err2 && !/duplicate column name/i.test(err2.message)) {
              console.error('Error adding column', col, err2.message);
            }
          }
        );
      }
    });
  });
}

// Create a messages table for storing in-app and newsletter messages.  Each message
// includes the recipient ID, optional sender ID, subject, body, and timestamps for
// creation and when it was read.  The table is created if it does not exist.
function ensureMessagesTable() {
  db.run(
    `CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient_id INTEGER NOT NULL,
      sender_id INTEGER,
      subject TEXT,
      body TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      read_at DATETIME
    )`
  );
}

// Extend user schema and ensure messages table exists.
extendUserSchema();
ensureMessagesTable();

// Create a prescriptions table for private prescriptions (A6). Each prescription
// record stores the basic fields required for printing, including insurance
// provider, patient details, doctor information and up to three medication
// lines. The table is created if it does not exist.
function ensurePrescriptionTable() {
  db.run(`CREATE TABLE IF NOT EXISTS prescriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    insurance TEXT,
    patient_name TEXT,
    patient_birth TEXT,
    insurance_number TEXT,
    doctor_practice TEXT,
    doctor_number TEXT,
    date TEXT,
    medication1 TEXT,
    medication2 TEXT,
    medication3 TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
}

// Seed additional cannabis products if they do not already ex

function extendPrescriptionSchema() {
  /*
   * Dynamically extend the prescriptions table with additional columns
   * required for the WannCannaMED Privatrezept-Workflow. Existing Daten
   * bleiben erhalten; neue Spalten werden mit NULL oder einem sinnvollen
   * Defaultwert angelegt.
   */
  const desired = [
    { name: 'street',           type: 'TEXT',   defaultExpr: "''" },
    { name: 'house_number',     type: 'TEXT',   defaultExpr: "''" },
    { name: 'zip_code',         type: 'TEXT',   defaultExpr: "''" },
    { name: 'city',             type: 'TEXT',   defaultExpr: "''" },
    { name: 'indication',       type: 'TEXT',   defaultExpr: "''" },
    { name: 'indication_other', type: 'TEXT',   defaultExpr: null },
    { name: 'previous_cannabis',type: 'INTEGER',defaultExpr: '0' },
    { name: 'medication_grams', type: 'REAL',   defaultExpr: null },
    { name: 'medication_strain',type: 'TEXT',   defaultExpr: null },
    { name: 'medication_text',  type: 'TEXT',   defaultExpr: null },
    { name: 'cost_confirmed',   type: 'INTEGER',defaultExpr: '0' }
  ];

  db.all('PRAGMA table_info(prescriptions)', (err, rows) => {
    if (err) {
      console.error('Error reading prescriptions table info', err.message);
      return;
    }
    const existing = rows.map(r => r.name);
    desired.forEach(col => {
      if (!existing.includes(col.name)) {
        const defaultClause = col.defaultExpr != null ? ` DEFAULT ${col.defaultExpr}` : '';
        const sql = `ALTER TABLE prescriptions ADD COLUMN ${col.name} ${col.type}${defaultClause}`;
        db.run(sql, alterErr => {
          if (alterErr) {
            console.error('Error extending prescriptions table with', col.name, alterErr.message);
          } else {
            console.log('Added column to prescriptions table:', col.name);
          }
        });
      }
    });
  });
}
// inserts three predefined strains into the products table along with
// descriptive metadata and placeholder images. If a product with the same
// title exists, it will not be duplicated.
function ensureAdditionalProducts() {
  const additional = [
    {
      title: 'Remexian Grape Galena 27/1',
      description:
        'Grape Galena ist eine indica-dominante Sorte mit 27% THC und <1% CBD. Sie ist unbestrahlt und kombiniert OG Kush × Lost Sailor × Platinum Kush. Aromen: fruchtig, blumig; Effekte: relaxed, schläfrig, glücklich; Terpene: Beta‑Myrcen, Limonen, Alpha‑Humulen, Linalool, Selinadiene.',
      price: 5.69,
      image: 'remexian.jpg',
      thc: '27%',
      cbd: '<1%',
      effects: 'Relaxed, Schläfrig, Glücklich',
      aroma: 'Fruchtig, Blumen',
      terpenes: 'Beta-Myrcen, Limonen, Alpha-Humulen, Linalool, Selinadiene'
    },
    {
      title: 'Peace Naturals GMO Cookies 31/1',
      description:
        'GMO Cookies (Girl Scout Cookies × Chemdawg) hat 31% THC und <1% CBD. Die Sorte ist eine starke Indica und unbestrahlt. Aroma: Diesel; Effekte: euphorisch, schläfrig, relaxed; Terpene: Limonen, Alpha‑Caryophyllen, Myrcen.',
      price: 6.3,
      image: 'gmo_cookies.jpg',
      thc: '31%',
      cbd: '<1%',
      effects: 'Euphorisch, Schläfrig, Relaxed',
      aroma: 'Diesel',
      terpenes: 'Limonen, Alpha-Caryophyllen, Myrcen'
    },
    {
      title: 'AMICI Blueberry Headband 22/1',
      description:
        'Blueberry Headband ist eine indica-dominante Hybride mit 22% THC und <1% CBD. Sie ist unbestrahlt und wird unter EU‑GMP‑Bedingungen in Portugal produziert. Das Aroma ist beerig‑würzig mit Noten von Mango, Thymian und Zitrusfrüchten. Effekte: cerebral, körperbetont, lang anhaltend, ausgewogen; Terpene: Caryophyllen, Linalool, Myrcen.',
      price: 5.5,
      image: 'blueberry_headband.jpg',
      thc: '22%',
      cbd: '<1%',
      effects: 'Cerebral, Körperbetont, Lang anhaltend, Ausgewogen',
      aroma: 'Beerig, Würzig',
      terpenes: 'Caryophyllen, Linalool, Myrcen'
    }
  ];
  additional.forEach(p => {
    db.get('SELECT id FROM products WHERE title = ?', [p.title], (err, row) => {
      if (err) {
        console.error('Fehler beim Prüfen der Sorte', p.title, err.message);
        return;
      }
      if (!row) {
        db.run(
          'INSERT INTO products (title, description, price, image, thc, cbd, effects, aroma, terpenes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [p.title, p.description, p.price, p.image, p.thc, p.cbd, p.effects, p.aroma, p.terpenes],
          err2 => {
            if (err2) {
              console.error('Fehler beim Einfügen der Sorte', p.title, err2.message);
            }
          }
        );
      }
    });
  });
}

// Insert an admin user if not present. We perform this on every
// startup; if the row already exists, we skip insertion.
async function ensureAdmin() {
  return new Promise((resolve, reject) => {
    db.get('SELECT id FROM users WHERE email = ?', ['Admin'], async (err, row) => {
      if (err) return reject(err);
      if (!row) {
        try {
          const hash = await bcrypt.hash('admin1234', 10);
          db.run(
            'INSERT INTO users (email, password_hash, is_admin, approved) VALUES (?, ?, 1, 1)',
            ['Admin', hash],
            err2 => {
              if (err2) return reject(err2);
              resolve();
            }
          );
        } catch (e) {
          reject(e);
        }
      } else {
        resolve();
      }
    });
  });
}

// Populate demo products if the table is empty. Uses simple
// placeholder products; feel free to modify or extend.
async function ensureProducts() {
  return new Promise((resolve, reject) => {
    db.get('SELECT COUNT(*) AS count FROM products', (err, row) => {
      if (err) return reject(err);
      if (row.count === 0) {
        const demo = [
          {
            title: 'Neon Smartphone',
            description: 'Ein futuristisches Smartphone mit leuchtenden Neon-Akzenten.',
            price: 499.99,
            image: 'smartphone.png'
          },
          {
            title: 'Neon Laptop',
            description: 'Leistungsstarker Laptop in knalligen Comic-Farben.',
            price: 899.99,
            image: 'laptop.png'
          },
          {
            title: 'Neon Headset',
            description: 'Stylishes Headset mit neonfarbenen Akzenten und tollem Sound.',
            price: 199.99,
            image: 'headset.png'
          }
        ];
        const stmt = db.prepare('INSERT INTO products (title, description, price, image) VALUES (?, ?, ?, ?)');
        demo.forEach(item => {
          stmt.run(item.title, item.description, item.price, item.image);
        });
        stmt.finalize(err2 => {
          if (err2) return reject(err2);
          resolve();
        });
      } else {
        resolve();
      }
    });
  });
}

// Immediately ensure the admin and demo products exist.
ensureAdmin().catch(err => console.error(err));
ensureProducts().catch(err => console.error(err));

// Ensure the prescriptions table exists and seed additional cannabis
// products (e.g. Remexian Grape Galena, Peace Naturals GMO Cookies, Blueberry
// Headband) if they are not already present. These calls run once at
// startup to upgrade the schema and populate the demo data.
ensurePrescriptionTable();
extendPrescriptionSchema();
ensureAdditionalProducts();

// Set the view engine to EJS and configure express static files.
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));
// Expose uploads directory as static.  Without this, images uploaded via
// multer cannot be served.  The UPLOAD_DIR defaults to a local `uploads`
// folder but can be pointed to a persistent mount via the environment.
// Serve uploads from both the default public/images directory and the
// persistent upload directory.  If a file is not found in the first
// directory it will fall back to the second.  This allows us to
// reference all product images uniformly via the /uploads path.
app.use('/uploads', express.static(path.join(__dirname, 'public/images')));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(helmet());

// Configure session management. Sessions are persisted in a SQLite
// database to survive application restarts.
app.use(
  session({
    // Persist session data alongside the database; SESSION_DIR defaults
    // to DATA_DIR so sessions survive application restarts when DATA_DIR
    // points to a persistent volume.
    store: new SQLiteStore({ db: 'sessions.db', dir: SESSION_DIR }),
    secret: process.env.SESSION_SECRET || 'replace_this_secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 } // 24 hours
  })
);

// Enable CSRF protection. Generate a token for each request and make
// it available in templates via res.locals.csrfToken.
app.use(csrf());
app.use((req, res, next) => {
  res.locals.csrfToken = req.csrfToken();
  res.locals.currentUser = req.session.user || null;
  next();
});

// Helper middleware to require that a user is authenticated and approved.
function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  // If not approved and not admin, show wait page
  if (!req.session.user.approved && !req.session.user.is_admin) {
    return res.render('awaiting');
  }
  next();
}

// Helper middleware to ensure the current user is an admin. This wraps
// requireAuth and then checks the is_admin flag. If the user is not
// an admin they are redirected to the showroom. Use this for admin
// specific routes like product management.
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.session.user.is_admin) {
      return res.redirect('/showroom');
    }
    next();
  });
}


// Helper functions for prescription dates and medication formatting
function getLastWorkdayDate() {
  const d = new Date();
  const day = d.getDay(); // Sunday = 0, Monday = 1, ... Saturday = 6
  if (day === 6) {
    d.setDate(d.getDate() - 1); // Saturday -> Friday
  } else if (day === 0) {
    d.setDate(d.getDate() - 2); // Sunday -> Friday
  }
  return d;
}

function formatDateISO(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const dayOfMonth = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${dayOfMonth}`;
}

function formatISOToDisplay(isoString) {
  if (!isoString || typeof isoString !== 'string') return '';
  const parts = isoString.split('-');
  if (parts.length !== 3) return isoString;
  const [year, month, day] = parts;
  return `${day}.${month}.${String(year).slice(-2)}`;
}

function normalizeGrams(raw) {
  if (raw == null) return NaN;
  const str = String(raw).replace(',', '.').trim();
  if (!str) return NaN;
  const num = Number(str);
  return Number.isFinite(num) ? num : NaN;
}

function formatGramsDE(num) {
  try {
    return num.toLocaleString('de-DE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  } catch (e) {
    return String(num);
  }
}

// Root route: redirect user depending on login status
app.get('/', (req, res) => {
  if (req.session.user) {
    if (req.session.user.is_admin) {
      return res.redirect('/admin');
    }
    return res.redirect('/showroom');
  }
  res.redirect('/login');
});

// Login routes
app.get('/login', (req, res) => {
  res.render('login', { errors: [] });
});

app.post('/login', async (req, res) => {
  /*
   * The login form accepts either an email address or a username in the same
   * input field.  We treat the incoming value as an identifier and search
   * against both the email and username columns.  If a matching user is
   * found and the password hashes compare, the user is stored in the
   * session.  Additional user fields (username, phone, newsletter_opt_in)
   * are exposed on the session for use in templates.
   */
  const { email: identifier, password } = req.body;
  if (!identifier || !password) {
    return res.render('login', { errors: [{ msg: 'Alle Felder sind erforderlich.' }] });
  }
  db.get('SELECT * FROM users WHERE email = ? OR username = ?', [identifier, identifier], async (err, user) => {
    if (err) {
      return res.render('login', { errors: [{ msg: 'Fehler beim Abrufen des Benutzers.' }] });
    }
    if (!user) {
      return res.render('login', { errors: [{ msg: 'Benutzer existiert nicht.' }] });
    }
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.render('login', { errors: [{ msg: 'Falsches Passwort.' }] });
    }
    // Save user details in session (without password_hash)
    req.session.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      phone: user.phone,
      is_admin: Boolean(user.is_admin),
      approved: Boolean(user.approved),
      newsletter_opt_in: Boolean(user.newsletter_opt_in)
    };
    // Redirect accordingly
    return res.redirect(user.is_admin ? '/admin' : '/showroom');
  });
});

// Registration routes
app.get('/register', (req, res) => {
  res.render('register', { errors: [] });
});

app.post('/register', async (req, res) => {
  /*
   * Extended registration collects a username, email, optional phone number,
   * and newsletter opt-in flag in addition to the password fields.  Basic
   * validations ensure required fields are present and that the passwords
   * match.  Duplicate username or email conflicts are handled via the
   * unique constraints on those columns.
   */
  const { username, email, phone, password, confirm_password, newsletter } = req.body;
  const errors = [];
  if (!username || !email || !password || !confirm_password) {
    errors.push({ msg: 'Benutzername, E-Mail und Passwort sind erforderlich.' });
  }
  if (password !== confirm_password) {
    errors.push({ msg: 'Passwörter stimmen nicht überein.' });
  }
  if (errors.length > 0) {
    return res.render('register', { errors });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const phoneVal = phone && phone.trim() ? phone.trim() : null;
    const newsletterOpt = newsletter ? 1 : 0;
    db.run(
      'INSERT INTO users (username, email, phone, password_hash, newsletter_opt_in, is_admin, approved) VALUES (?, ?, ?, ?, ?, 0, 0)',
      [username.trim(), email.trim(), phoneVal, hash, newsletterOpt],
      function (err) {
        if (err) {
          const message = err.message && err.message.includes('UNIQUE')
            ? 'Benutzername oder E-Mail existiert bereits.'
            : 'Fehler beim Registrieren des Benutzers.';
          return res.render('register', { errors: [{ msg: message }] });
        }
        // Registration successful: show awaiting approval message
        return res.render('awaiting');
      }
    );
  } catch (e) {
    return res.render('register', { errors: [{ msg: 'Fehler beim Registrieren.' }] });
  }
});

// Logout route
app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    res.redirect('/login');
  });
});

// Showroom for regular users
app.get('/showroom', requireAuth, (req, res) => {
  // Only non-admin users should access showroom
  if (req.session.user.is_admin) {
    return res.redirect('/admin');
  }
  db.all('SELECT * FROM products', [], (err, products) => {
    if (err) {
      return res.render('showroom', { products: [], error: 'Fehler beim Abrufen der Produkte.' });
    }
    res.render('showroom', { products, error: null });
  });
});

// Admin dashboard: list unapproved users and allow approval
app.get('/admin', requireAuth, (req, res) => {
  if (!req.session.user.is_admin) {
    return res.redirect('/showroom');
  }
  // Include additional columns (username, phone, newsletter_opt_in) when listing users for the admin
  db.all('SELECT id, username, email, phone, is_admin, approved, newsletter_opt_in FROM users WHERE id != ?', [req.session.user.id], (err, users) => {
    if (err) {
      return res.render('admin', { users: [], error: 'Fehler beim Abrufen der Benutzerliste.' });
    }
    res.render('admin', { users, error: null });
  });
});

// Admin approves a user
app.post('/admin/approve/:id', requireAuth, (req, res) => {
  if (!req.session.user.is_admin) {
    return res.status(403).send('Nicht autorisiert');
  }
  const userId = req.params.id;
  db.run('UPDATE users SET approved = 1 WHERE id = ?', [userId], err => {
    if (err) {
      return res.status(500).send('Fehler beim Aktualisieren des Benutzers');
    }
    res.redirect('/admin');
  });
});

// Admin product management

// List all products
app.get('/admin/products', requireAdmin, (req, res) => {
  db.all('SELECT * FROM products', [], (err, products) => {
    if (err) {
      return res.render('admin-products', { products: [], error: 'Fehler beim Abrufen der Sorten.' });
    }
    res.render('admin-products', { products, error: null });
  });
});

// New product form
app.get('/admin/products/new', requireAdmin, (req, res) => {
  res.render('admin-product-form', { product: null, errors: [] });
});

// Create new product
app.post('/admin/products/new', requireAdmin, upload.single('imageFile'), (req, res) => {
  /*
   * Extract form values for a new product. In addition to the basic fields
   * (title, description, price), we support optional metadata fields for
   * THC, CBD, effects, aroma and terpenes. Images can be uploaded via
   * multipart/form-data; if no file is uploaded, the placeholder image
   * is used. All inputs are validated and errors result in the form
   * being re-rendered.
   */
  const {
    title,
    description,
    price,
    thc,
    cbd,
    effects,
    aroma,
    terpenes
  } = req.body;
  const errors = [];
  if (!title || !description || !price) {
    errors.push({ msg: 'Alle Felder außer Bild sind erforderlich.' });
  }
  const numericPrice = parseFloat(price);
  if (isNaN(numericPrice) || numericPrice < 0) {
    errors.push({ msg: 'Preis muss eine positive Zahl sein.' });
  }
  if (errors.length > 0) {
    return res.render('admin-product-form', { product: null, errors });
  }
  // Determine file name: use uploaded file if present, otherwise fallback to placeholder
  let imageFile = 'placeholder.png';
  if (req.file && req.file.filename) {
    imageFile = req.file.filename;
  }
  // Provide default values for optional metadata
  const meta = {
    thc: thc ? thc.trim() : '',
    cbd: cbd ? cbd.trim() : '',
    effects: effects ? effects.trim() : '',
    aroma: aroma ? aroma.trim() : '',
    terpenes: terpenes ? terpenes.trim() : ''
  };
  db.run(
    'INSERT INTO products (title, description, price, image, thc, cbd, effects, aroma, terpenes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      title.trim(),
      description.trim(),
      numericPrice,
      imageFile,
      meta.thc,
      meta.cbd,
      meta.effects,
      meta.aroma,
      meta.terpenes
    ],
    err => {
      if (err) {
        return res.render('admin-product-form', {
          product: null,
          errors: [{ msg: 'Fehler beim Erstellen der Sorte.' }]
        });
      }
      res.redirect('/admin/products');
    }
  );
});

// Product detail page
app.get('/admin/products/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  db.get('SELECT * FROM products WHERE id = ?', [id], (err, product) => {
    if (err || !product) {
      return res.redirect('/admin/products');
    }
    res.render('admin-product-detail', { product });
  });
});

// Edit product form
app.get('/admin/products/:id/edit', requireAdmin, (req, res) => {
  const id = req.params.id;
  db.get('SELECT * FROM products WHERE id = ?', [id], (err, product) => {
    if (err || !product) {
      return res.redirect('/admin/products');
    }
    res.render('admin-product-form', { product, errors: [] });
  });
});

// Update product
app.post('/admin/products/:id/edit', requireAdmin, upload.single('imageFile'), (req, res) => {
  const id = req.params.id;
  const {
    title,
    description,
    price,
    thc,
    cbd,
    effects,
    aroma,
    terpenes
  } = req.body;
  const errors = [];
  if (!title || !description || !price) {
    errors.push({ msg: 'Alle Felder außer Bild sind erforderlich.' });
  }
  const numericPrice = parseFloat(price);
  if (isNaN(numericPrice) || numericPrice < 0) {
    errors.push({ msg: 'Preis muss eine positive Zahl sein.' });
  }
  if (errors.length > 0) {
    // When validation errors occur we still render the form with the submitted
    // fields populated. Because no new file has been processed yet, reuse
    // the current image if available, otherwise leave it blank.  `req.body` does
    // not include the image field for multipart forms so we fetch it from the
    // database later when editing without a new file.  Here we set it to
    // undefined as a placeholder; the template will handle missing images.
    return res.render('admin-product-form', {
      product: {
        id,
        title,
        description,
        price,
        image: '',
        thc,
        cbd,
        effects,
        aroma,
        terpenes
      },
      errors
    });
  }
  // Prepare metadata with defaults
  const meta = {
    thc: thc ? thc.trim() : '',
    cbd: cbd ? cbd.trim() : '',
    effects: effects ? effects.trim() : '',
    aroma: aroma ? aroma.trim() : '',
    terpenes: terpenes ? terpenes.trim() : ''
  };
  // Determine file name: if a new file is uploaded, use it; otherwise fall back to existing image name passed in hidden input
  let newImage = null;
  if (req.file && req.file.filename) {
    newImage = req.file.filename;
  }
  // Retrieve current image from DB if we need to keep it
  db.get('SELECT image FROM products WHERE id = ?', [id], (imgErr, row) => {
    if (imgErr || !row) {
      return res.render('admin-product-form', {
        product: { id, title, description, price, image: row ? row.image : '', thc, cbd, effects, aroma, terpenes },
        errors: [{ msg: 'Fehler beim Laden der bestehenden Sorte.' }]
      });
    }
    const imageFile = newImage || row.image;
    db.run(
      'UPDATE products SET title = ?, description = ?, price = ?, image = ?, thc = ?, cbd = ?, effects = ?, aroma = ?, terpenes = ? WHERE id = ?',
      [
        title.trim(),
        description.trim(),
        numericPrice,
        imageFile,
        meta.thc,
        meta.cbd,
        meta.effects,
        meta.aroma,
        meta.terpenes,
        id
      ],
      err2 => {
        if (err2) {
          return res.render('admin-product-form', {
            product: {
              id,
              title,
              description,
              price,
              image: imageFile,
              thc,
              cbd,
              effects,
              aroma,
              terpenes
            },
            errors: [{ msg: 'Fehler beim Aktualisieren der Sorte.' }]
          });
        }
        res.redirect('/admin/products');
      }
    );
  });
});

// Delete product
app.post('/admin/products/:id/delete', requireAdmin, (req, res) => {
  const id = req.params.id;
  db.run('DELETE FROM products WHERE id = ?', [id], err => {
    // Ignore errors here and always redirect
    res.redirect('/admin/products');
  });
});

/*
 * Unread message count API
 *
 * Returns a JSON object with the number of unread messages for the
 * currently logged-in user. This endpoint is used by the client-side
 * polling script to update the unread badge in the navigation bar.
 */
app.get('/api/unread-count', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  db.get(
    'SELECT COUNT(*) AS count FROM messages WHERE recipient_id = ? AND read_at IS NULL',
    [userId],
    (err, row) => {
      if (err) {
        return res.json({ count: 0 });
      }
      res.json({ count: row ? row.count : 0 });
    }
  );
});

/*
 * Prescription creation routes
 *
 * The GET route renders a form where the user (typically a doctor) can
 * input all necessary data for a private cannabis prescription. The POST
 * route stores the prescription in the database and redirects to a print
 * view with the data positioned on an A6 template.
 */
app.get('/prescriptions/new', requireAuth, (req, res) => {
  // Only approved users or admins may create prescriptions
  if (!req.session.user.approved && !req.session.user.is_admin) {
    return res.render('awaiting');
  }
  const lastWorkday = getLastWorkdayDate();
  const prescriptionDateISO = formatDateISO(lastWorkday);
  const prescriptionDateDisplay = formatISOToDisplay(prescriptionDateISO);
  res.render('prescription-form', {
    errors: [],
    formData: {},
    prescriptionDateDisplay
  });
});

app.post('/prescriptions/new', requireAuth, (req, res) => {
  const {
    first_name,
    last_name,
    street,
    house_number,
    zip_code,
    city,
    patient_birth,
    insurance_number,
    doctor_practice,
    doctor_number,
    indication,
    indication_other,
    previous_cannabis,
    medication_grams,
    medication_strain,
    cost_confirm
  } = req.body;

  const errors = [];

  // Pflichtfelder prüfen
  if (!first_name || !first_name.trim()) {
    errors.push({ msg: 'Vorname ist erforderlich.' });
  }
  if (!last_name || !last_name.trim()) {
    errors.push({ msg: 'Nachname ist erforderlich.' });
  }
  if (!street || !street.trim()) {
    errors.push({ msg: 'Straße ist erforderlich.' });
  }
  if (!house_number || !house_number.trim()) {
    errors.push({ msg: 'Hausnummer ist erforderlich.' });
  }
  if (!zip_code || !zip_code.trim()) {
    errors.push({ msg: 'Postleitzahl ist erforderlich.' });
  }
  if (!city || !city.trim()) {
    errors.push({ msg: 'Wohnort ist erforderlich.' });
  }
  if (!patient_birth) {
    errors.push({ msg: 'Geburtsdatum ist erforderlich.' });
  }
  if (!indication) {
    errors.push({ msg: 'Bitte geben Sie den Grund für das Privatrezept an.' });
  }
  if (cost_confirm !== 'ja') {
    errors.push({ msg: 'Bitte bestätigen Sie, dass die Erstellung eines Privatrezepts 10 € kostet und bei Abholung zu bezahlen ist.' });
  }

  const gramsNumber = normalizeGrams(medication_grams);
  if (!Number.isFinite(gramsNumber) || gramsNumber <= 0) {
    errors.push({ msg: 'Bitte geben Sie eine gültige Menge in Gramm ein.' });
  }
  if (!medication_strain || !medication_strain.trim()) {
    errors.push({ msg: 'Bitte geben Sie die Cannabissorte an.' });
  }

  const lastWorkday = getLastWorkdayDate();
  const prescriptionDateISO = formatDateISO(lastWorkday);

  if (errors.length > 0) {
    const prescriptionDateDisplay = formatISOToDisplay(prescriptionDateISO);
    return res.status(400).render('prescription-form', {
      errors,
      formData: req.body,
      prescriptionDateDisplay
    });
  }

  const insurance = 'Privat';
  const patient_name = `${last_name.trim()}, ${first_name.trim()} ${street.trim()} ${house_number.trim()} D-${zip_code.trim()} ${city.trim()}`;
  const prevFlag = previous_cannabis === 'ja' ? 1 : 0;
  const costConfirmedFlag = cost_confirm === 'ja' ? 1 : 0;

  const gramsText = formatGramsDE(gramsNumber);
  const strainText = medication_strain.trim();

  const medicationText =
    `${gramsText}g Cannabisblüten, "${strainText}", ` +
    `unzerkleinert, verdampfen/inhalieren, ` +
    `Dosierung: ED 0,01g TD 1,00g`;

  // medication1 erhält den vorbereiteten Text für den Druck;
  // weitere Zeilen bleiben optional frei.
  const medication1 = medicationText;
  const medication2 = null;
  const medication3 = null;

  db.run(
    `INSERT INTO prescriptions (
      user_id,
      insurance,
      patient_name,
      patient_birth,
      insurance_number,
      doctor_practice,
      doctor_number,
      date,
      medication1,
      medication2,
      medication3,
      street,
      house_number,
      zip_code,
      city,
      indication,
      indication_other,
      previous_cannabis,
      medication_grams,
      medication_strain,
      medication_text,
      cost_confirmed
    )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.session.user.id,
      insurance,
      patient_name,
      patient_birth,
      insurance_number ? insurance_number.trim() : null,
      doctor_practice ? doctor_practice.trim() : null,
      doctor_number ? doctor_number.trim() : null,
      prescriptionDateISO,
      medication1,
      medication2,
      medication3,
      street.trim(),
      house_number.trim(),
      zip_code.trim(),
      city.trim(),
      indication,
      indication_other && indication_other.trim() ? indication_other.trim() : null,
      prevFlag,
      gramsNumber,
      strainText,
      medicationText,
      costConfirmedFlag
    ],
    function (err) {
      if (err) {
        console.error('Fehler beim Speichern des Rezepts:', err.message);
        const prescriptionDateDisplay = formatISOToDisplay(prescriptionDateISO);
        return res.status(500).render('prescription-form', {
          errors: [{ msg: 'Fehler beim Speichern des Rezepts.' }],
          formData: req.body,
          prescriptionDateDisplay
        });
      }
      // Success: Hinweis-Seite, Admin druckt später das Rezept.
      res.redirect('/prescriptions/success');
    }
  );
});
// Print view for a prescription. Only admins may access this route.
app.get('/prescriptions/:id/print', requireAdmin, (req, res) => {
  const id = req.params.id;
  db.get('SELECT * FROM prescriptions WHERE id = ?', [id], (err, prescription) => {
    if (err || !prescription) {
      return res.status(404).render('404');
    }
    const dateDisplay = formatISOToDisplay(prescription.date);
    const birthDisplay = formatISOToDisplay(prescription.patient_birth);
    // Only admin can print prescriptions
    res.render('prescription-print', {
      prescription,
      dateDisplay,
      birthDisplay
    });
  });
});

// Success page shown to users after creating a prescription.  Users are not shown
// the actual prescription document here.  They are informed that the
// prescription has been created and that output is handled by the admin.
app.get('/prescriptions/success', requireAuth, (req, res) => {
  res.render('prescription-success');
});

// Admin route: list all prescriptions for printing.  Displays all records
// in descending order of creation.  Admins can then click to print each
// prescription individually.
app.get('/admin/prescriptions', requireAdmin, (req, res) => {
  db.all('SELECT * FROM prescriptions ORDER BY created_at DESC', [], (err, rows) => {
    if (err) {
      return res.render('admin-prescriptions', { prescriptions: [], error: 'Fehler beim Abrufen der Rezepte.' });
    }
    res.render('admin-prescriptions', { prescriptions: rows, error: null });
  });
});

/*
 * Messaging and newsletter routes
 */

// Show inbox for the current user.  Lists all messages addressed to
// the user sorted by most recent first.
app.get('/inbox', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  db.all(
    'SELECT id, recipient_id, sender_id, subject, body, created_at, read_at FROM messages WHERE recipient_id = ? ORDER BY created_at DESC',
    [userId],
    (err, rows) => {
      if (err) {
        return res.render('inbox', { msgs: [], error: 'Fehler beim Laden der Nachrichten.' });
      }
      res.render('inbox', { msgs: rows });
    }
  );
});

// Mark a message as read.  Only the recipient may mark a message as read.
app.post('/messages/:id/read', requireAuth, (req, res) => {
  const messageId = req.params.id;
  const userId = req.session.user.id;
  db.run('UPDATE messages SET read_at = CURRENT_TIMESTAMP WHERE id = ? AND recipient_id = ?', [messageId, userId], () => {
    res.redirect('/inbox');
  });
});

// Admin: newsletter form
app.get('/admin/newsletter', requireAdmin, (req, res) => {
  res.render('admin-newsletter', { error: null, info: null, success: null });
});

// Admin: send newsletter to all approved subscribers
app.post('/admin/newsletter/send', requireAdmin, (req, res) => {
  const { subject, body } = req.body;
  if (!subject || !body) {
    return res.render('admin-newsletter', { error: 'Betreff und Text sind erforderlich.', info: null, success: null });
  }
  db.all('SELECT id FROM users WHERE approved = 1 AND newsletter_opt_in = 1', [], (err, users) => {
    if (err) {
      return res.render('admin-newsletter', { error: 'Fehler beim Abrufen der Abonnenten.', info: null, success: null });
    }
    if (!users || users.length === 0) {
      return res.render('admin-newsletter', { error: null, info: 'Keine Abonnenten vorhanden.', success: null });
    }
    const stmt = db.prepare('INSERT INTO messages (recipient_id, sender_id, subject, body) VALUES (?, ?, ?, ?)');
    users.forEach(u => {
      stmt.run(u.id, req.session.user.id, subject, body);
    });
    stmt.finalize(() => {
      res.render('admin-newsletter', { error: null, info: null, success: 'Newsletter wurde versendet.' });
    });
  });
});

// Admin: export newsletter subscribers as CSV
app.get('/admin/newsletter/csv', requireAdmin, (req, res) => {
  db.all('SELECT username, email, phone FROM users WHERE approved = 1 AND newsletter_opt_in = 1', [], (err, rows) => {
    if (err) {
      return res.status(500).send('Fehler beim Exportieren der Abonnenten.');
    }
    let csv = 'username,email,phone\n';
    rows.forEach(r => {
      const userName = r.username || '';
      const email = r.email || '';
      const phone = r.phone || '';
      csv += `"${userName.replace(/"/g, '""')}","${email.replace(/"/g, '""')}","${phone.replace(/"/g, '""')}"\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="newsletter-subscribers.csv"');
    res.send(csv);
  });
});

// Admin: display form to send a message to a specific user
app.get('/admin/users/:id/message', requireAdmin, (req, res) => {
  const targetId = req.params.id;
  db.get('SELECT id, username, email FROM users WHERE id = ?', [targetId], (err, user) => {
    if (err || !user) {
      return res.status(404).render('404');
    }
    res.render('admin-message-user', { user, error: null });
  });
});

// Admin: handle sending a targeted message
app.post('/admin/users/:id/message', requireAdmin, (req, res) => {
  const targetId = req.params.id;
  const { subject, body } = req.body;
  if (!subject || !body) {
    db.get('SELECT id, username, email FROM users WHERE id = ?', [targetId], (err, user) => {
      if (err || !user) {
        return res.status(404).render('404');
      }
      return res.render('admin-message-user', { user, error: 'Betreff und Text sind erforderlich.' });
    });
    return;
  }
  db.run(
    'INSERT INTO messages (recipient_id, sender_id, subject, body) VALUES (?, ?, ?, ?)',
    [targetId, req.session.user.id, subject, body],
    err => {
      if (err) {
        db.get('SELECT id, username, email FROM users WHERE id = ?', [targetId], (err2, user) => {
          return res.render('admin-message-user', { user, error: 'Fehler beim Senden der Nachricht.' });
        });
      } else {
        res.redirect('/admin');
      }
    }
  );
});

// Fallback 404

// Handle CSRF token errors gracefully.  When a CSRF mismatch occurs,
// csurf throws an error with code EBADCSRFTOKEN.  Here we catch
// the error and render the 404 template with a custom message.
app.use(function (err, req, res, next) {
  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).render('404', { message: 'forbidden' });
  }
  return next(err);
});

// Fallback 404
app.use((req, res) => {
  res.status(404).render('404');
});

// Start the Express server
app.listen(PORT, () => {
  console.log(`Express server listening on http://localhost:${PORT}`);
});