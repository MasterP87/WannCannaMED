const path = require('path');
const express = require('express');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// -------------------------------------------------------------------
// Postgres-Verbindung (Render: DATABASE_URL mit SSL)
// -------------------------------------------------------------------
const connectionString = process.env.DATABASE_URL || '';

const pool = new Pool({
    connectionString,
    ssl: connectionString ? { rejectUnauthorized: false } : false,
});

async function initDb() {
    // Tabelle für Sorten
    await pool.query(`
        CREATE TABLE IF NOT EXISTS sorten (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            thc_value TEXT,
            cbd_value TEXT,
            description TEXT,
            price_per_gram NUMERIC(10,2),
            in_stock INTEGER NOT NULL DEFAULT 1,
            created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
    `);

    // Tabelle für Privatrezept-Anfragen inkl. Medikation
    await pool.query(`
        CREATE TABLE IF NOT EXISTS private_prescriptions (
            id SERIAL PRIMARY KEY,
            first_name TEXT NOT NULL,
            last_name TEXT NOT NULL,
            street TEXT NOT NULL,
            house_number TEXT NOT NULL,
            zip_code TEXT NOT NULL,
            city TEXT NOT NULL,
            birthdate TEXT NOT NULL,
            prescription_date TEXT NOT NULL,
            kostentraeger TEXT NOT NULL DEFAULT 'Privat',
            indication TEXT NOT NULL,
            indication_other TEXT,
            previous_cannabis INTEGER NOT NULL,
            medication_grams NUMERIC(10,2) NOT NULL,
            medication_strain TEXT NOT NULL,
            medication_text TEXT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
    `);

    console.log('Datenbanktabellen geprüft/erstellt.');
}

initDb().catch(err => {
    console.error('Fehler bei initDb:', err);
});

// -------------------------------------------------------------------
// Basis-Konfiguration Express
// -------------------------------------------------------------------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// -------------------------------------------------------------------
// Hilfsfunktionen
// -------------------------------------------------------------------
function getLastWorkdayDate() {
    const d = new Date();
    const day = d.getDay(); // Sonntag = 0, Montag = 1, ... Samstag = 6
    if (day === 6) {
        d.setDate(d.getDate() - 1); // Samstag -> Freitag
    } else if (day === 0) {
        d.setDate(d.getDate() - 2); // Sonntag -> Freitag
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
    } catch {
        return String(num);
    }
}

// -------------------------------------------------------------------
// Routen
// -------------------------------------------------------------------

// Startseite: Sorten + Hinweis auf Privatrezept
app.get('/', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, name, thc_value, cbd_value, description, price_per_gram, in_stock
            FROM sorten
            ORDER BY name ASC
        `);
        const strains = result.rows || [];
        res.render('index', {
            strains,
            error: null,
        });
    } catch (err) {
        console.error('Fehler beim Laden der Sorten:', err);
        res.render('index', {
            strains: [],
            error: 'Fehler beim Laden der Sorten.',
        });
    }
});

// GET: Privatrezept-Fragebogen
app.get('/privatrezept', (req, res) => {
    const lastWorkday = getLastWorkdayDate();
    const prescriptionDateDisplay = formatISOToDisplay(formatDateISO(lastWorkday));
    res.render('privatrezept_form', {
        prescriptionDateDisplay,
        errors: [],
        formData: {},
    });
});

// POST: Privatrezept speichern
app.post('/privatrezept', async (req, res) => {
    const {
        first_name,
        last_name,
        street,
        house_number,
        zip_code,
        city,
        birthdate,
        indication,
        indication_other,
        previous_cannabis,
        medication_grams,
        medication_strain,
        cost_confirm,
    } = req.body;

    const errors = [];

    if (!first_name || !first_name.trim()) errors.push('Vorname ist erforderlich.');
    if (!last_name || !last_name.trim()) errors.push('Nachname ist erforderlich.');
    if (!street || !street.trim()) errors.push('Straße ist erforderlich.');
    if (!house_number || !house_number.trim()) errors.push('Hausnummer ist erforderlich.');
    if (!zip_code || !zip_code.trim()) errors.push('Postleitzahl ist erforderlich.');
    if (!city || !city.trim()) errors.push('Wohnort ist erforderlich.');
    if (!birthdate) errors.push('Geburtsdatum ist erforderlich.');
    if (!indication) errors.push('Bitte geben Sie den Grund für das Privatrezept an.');

    if (cost_confirm !== 'ja') {
        errors.push('Bitte bestätigen Sie, dass die Erstellung eines Privatrezepts 10 € kostet und bei Abholung zu bezahlen ist.');
    }

    const gramsVal = normalizeGrams(medication_grams);
    if (!Number.isFinite(gramsVal) || gramsVal <= 0) {
        errors.push('Menge in Gramm ist erforderlich und muss größer als 0 sein.');
    }
    if (!medication_strain || !medication_strain.trim()) {
        errors.push('Cannabissorte ist erforderlich.');
    }

    if (errors.length > 0) {
        const lastWorkday = getLastWorkdayDate();
        const prescriptionDateDisplay = formatISOToDisplay(formatDateISO(lastWorkday));
        return res.status(400).render('privatrezept_form', {
            prescriptionDateDisplay,
            errors,
            formData: req.body,
        });
    }

    const lastWorkday = getLastWorkdayDate();
    const prescriptionDateISO = formatDateISO(lastWorkday);
    const kostentraeger = 'Privat';
    const prevCannabisFlag = previous_cannabis === 'ja' ? 1 : 0;
    const createdAt = new Date().toISOString();

    const gramsNumber = normalizeGrams(medication_grams);
    const gramsText = formatGramsDE(gramsNumber);
    const strainText = medication_strain.trim();

    const medicationText =
        `${gramsText}g Cannabisblüten, "${strainText}", ` +
        `unzerkleinert, verdampfen/inhalieren, ` +
        `Dosierung: ED 0,01g TD 1,00g`;

    const sql = `
        INSERT INTO private_prescriptions
        (
            first_name,
            last_name,
            street,
            house_number,
            zip_code,
            city,
            birthdate,
            prescription_date,
            kostentraeger,
            indication,
            indication_other,
            previous_cannabis,
            medication_grams,
            medication_strain,
            medication_text,
            created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        RETURNING id
    `;

    const params = [
        first_name.trim(),
        last_name.trim(),
        street.trim(),
        house_number.trim(),
        zip_code.trim(),
        city.trim(),
        birthdate,
        prescriptionDateISO,
        kostentraeger,
        indication,
        indication_other && indication_other.trim() ? indication_other.trim() : null,
        prevCannabisFlag,
        gramsNumber,
        strainText,
        medicationText,
        createdAt,
    ];

    try {
        const result = await pool.query(sql, params);
        const newId = result.rows[0].id;
        res.redirect(`/privatrezept/success/${newId}`);
    } catch (err) {
        console.error('Fehler beim Speichern des Privatrezepts:', err);
        const lastWorkday = getLastWorkdayDate();
        const prescriptionDateDisplay = formatISOToDisplay(formatDateISO(lastWorkday));
        return res.status(500).render('privatrezept_form', {
            prescriptionDateDisplay,
            errors: ['Interner Fehler beim Speichern des Privatrezepts.'],
            formData: req.body,
        });
    }
});

// Bestätigungsseite nach erfolgreicher Speicherung
app.get('/privatrezept/success/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
        return res.status(400).send('Ungültige ID.');
    }

    const sql = `
        SELECT
            id,
            first_name,
            last_name,
            street,
            house_number,
            zip_code,
            city,
            birthdate,
            prescription_date,
            kostentraeger,
            indication,
            indication_other,
            previous_cannabis,
            medication_grams,
            medication_strain,
            medication_text,
            created_at
        FROM private_prescriptions
        WHERE id = $1
    `;

    try {
        const result = await pool.query(sql, [id]);
        if (!result.rows.length) {
            return res.status(404).send('Privatrezept nicht gefunden.');
        }
        const row = result.rows[0];
        const prescriptionDateDisplay = formatISOToDisplay(row.prescription_date);
        const birthdateDisplay = formatISOToDisplay(row.birthdate);

        res.render('privatrezept_success', {
            prescription: row,
            prescriptionDateDisplay,
            birthdateDisplay,
        });
    } catch (err) {
        console.error('Fehler beim Laden des Datensatzes:', err);
        return res.status(500).send('Interner Fehler beim Laden des Datensatzes.');
    }
});

// Admin: Liste aller Privatrezept-Datensätze
app.get('/admin/privatrezept', async (req, res) => {
    const sql = `
        SELECT
            id,
            first_name,
            last_name,
            zip_code,
            city,
            prescription_date,
            indication,
            indication_other,
            medication_grams,
            medication_strain,
            created_at
        FROM private_prescriptions
        ORDER BY created_at DESC, id DESC
    `;
    try {
        const result = await pool.query(sql);
        const rows = result.rows || [];
        const entries = rows.map(row => ({
            id: row.id,
            first_name: row.first_name,
            last_name: row.last_name,
            zip_code: row.zip_code,
            city: row.city,
            indication: row.indication,
            indication_other: row.indication_other,
            medication_short: `${formatGramsDE(Number(row.medication_grams))}g ${row.medication_strain}`,
            prescriptionDateDisplay: formatISOToDisplay(row.prescription_date),
            createdAtDisplay: row.created_at,
        }));
        res.render('admin_privatrezept_list', { entries });
    } catch (err) {
        console.error('Fehler beim Laden der Privatrezept-Daten:', err);
        return res.status(500).send('Interner Fehler beim Laden der Privatrezept-Daten.');
    }
});

// Admin: Vorschau + Druckansicht eines einzelnen Privatrezepts
app.get('/admin/privatrezept/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
        return res.status(400).send('Ungültige ID.');
    }

    const sql = `
        SELECT
            id,
            first_name,
            last_name,
            street,
            house_number,
            zip_code,
            city,
            birthdate,
            prescription_date,
            kostentraeger,
            indication,
            indication_other,
            previous_cannabis,
            medication_text,
            created_at
        FROM private_prescriptions
        WHERE id = $1
    `;

    try {
        const result = await pool.query(sql, [id]);
        if (!result.rows.length) {
            return res.status(404).send('Privatrezept nicht gefunden.');
        }
        const row = result.rows[0];
        const prescriptionDateDisplay = formatISOToDisplay(row.prescription_date);
        const birthdateDisplay = formatISOToDisplay(row.birthdate);

        res.render('admin_privatrezept_preview', {
            prescription: row,
            prescriptionDateDisplay,
            birthdateDisplay,
        });
    } catch (err) {
        console.error('Fehler beim Laden des Datensatzes (Admin):', err);
        return res.status(500).send('Interner Fehler beim Laden des Datensatzes.');
    }
});

// -------------------------------------------------------------------
// Serverstart
// -------------------------------------------------------------------
app.listen(PORT, () => {
    console.log(`Server läuft auf http://localhost:${PORT}`);
});
