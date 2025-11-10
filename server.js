require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcrypt');
const csrf = require('csurf');
const helmet = require('helmet');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// Configure the SQLite database. The database file lives alongside
// server.js so it persists between application restarts. If the file
// doesn't exist it will be created automatically.
const dbPath = path.join(__dirname, 'data.db');
const db = new sqlite3.Database(dbPath);

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
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    approved INTEGER DEFAULT 0,
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

// Set the view engine to EJS and configure express static files.
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(helmet());

// Configure session management. Sessions are persisted in a SQLite
// database to survive application restarts.
app.use(
  session({
    store: new SQLiteStore({ db: 'sessions.db', dir: __dirname }),
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

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.render('login', { errors: [{ msg: 'Alle Felder sind erforderlich.' }] });
  }
  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
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
      email: user.email,
      is_admin: Boolean(user.is_admin),
      approved: Boolean(user.approved)
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
  const { email, password, confirm_password } = req.body;
  const errors = [];
  if (!email || !password || !confirm_password) {
    errors.push({ msg: 'Alle Felder sind erforderlich.' });
  }
  if (password !== confirm_password) {
    errors.push({ msg: 'Passwörter stimmen nicht überein.' });
  }
  if (errors.length > 0) {
    return res.render('register', { errors });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    db.run(
      'INSERT INTO users (email, password_hash, is_admin, approved) VALUES (?, ?, 0, 0)',
      [email, hash],
      function (err) {
        if (err) {
          const message = err.message.includes('UNIQUE')
            ? 'Benutzer mit dieser E-Mail existiert bereits.'
            : 'Fehler beim Registrieren des Benutzers.';
          return res.render('register', { errors: [{ msg: message }] });
        }
        // Registration successful: redirect to login with message
        return res.render('login', { errors: [{ msg: 'Registrierung erfolgreich! Warte auf Freigabe durch den Admin.' }] });
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
  db.all('SELECT id, email, is_admin, approved FROM users WHERE id != ?', [req.session.user.id], (err, users) => {
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
    return res.render('admin-product-form', {
      product: {
        id,
        title,
        description,
        price,
        image,
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

// Fallback 404
app.use((req, res) => {
  res.status(404).render('404');
});

// Start the Express server
app.listen(PORT, () => {
  console.log(`Express server listening on http://localhost:${PORT}`);
});