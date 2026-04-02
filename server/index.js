// CardLedger — Express + SQLite backend
// Run: node server/index.js
const path = require('path');

// Try multiple .env locations in case of different working directories
const envPaths = [
  path.join(__dirname, '../.env'),   // cardledger/.env  (run from server/)
  path.join(__dirname, '.env'),      // cardledger/server/.env
  path.join(process.cwd(), '.env'),  // wherever node was launched from
];

let envLoaded = false;
for (const p of envPaths) {
  const result = require('dotenv').config({ path: p });
  if (!result.error) {
    process.stdout.write(`[env] loaded from: ${p}\n`);
    process.stdout.write(`[env] S3_BUCKET = ${process.env.S3_BUCKET || '(not set)'}\n`);
    process.stdout.write(`[env] AWS_REGION = ${process.env.AWS_REGION || '(not set)'}\n`);
    envLoaded = true;
    break;
  }
}
if (!envLoaded) {
  process.stdout.write(`[env] WARNING: no .env file found, tried:\n`);
  envPaths.forEach(p => process.stdout.write(`  ${p}\n`));
}

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const DB      = require('better-sqlite3');
const multer  = require('multer');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Upload directory (local fallback when S3 not configured) ──────────────────
const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// ── S3 config (set these env vars to enable S3; omit to use local storage) ────
const S3_BUCKET   = process.env.S3_BUCKET  || '';
const S3_REGION   = process.env.AWS_REGION || 'us-east-1';
const S3_BASE_URL = S3_BUCKET ? `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com` : '';
const USE_LOCAL   = (process.env.USE_LOCAL_STORAGE || 'true').toLowerCase() !== 'false';
const useS3       = !USE_LOCAL && !!S3_BUCKET;

// If USE_LOCAL_STORAGE=false, S3 must be configured — refuse to start otherwise
if (!USE_LOCAL && !S3_BUCKET) {
  process.stderr.write('\n[FATAL] USE_LOCAL_STORAGE=false but S3_BUCKET is not set in .env\n');
  process.stderr.write('[FATAL] Set S3_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY\n\n');
  process.exit(1);
}

let s3Client = null;
if (useS3) {
  try {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3Client = new S3Client({ region: S3_REGION });
    console.log(`[s3] enabled — bucket: ${S3_BUCKET} region: ${S3_REGION} (public URLs)`);
  } catch(e) {
    if (!USE_LOCAL) {
      process.stderr.write(`\n[FATAL] USE_LOCAL_STORAGE=false but @aws-sdk/client-s3 failed: ${e.message}\n`);
      process.stderr.write('[FATAL] Run: npm install @aws-sdk/client-s3\n\n');
      process.exit(1);
    }
    console.warn('[s3] @aws-sdk/client-s3 not installed — run: npm install @aws-sdk/client-s3');
  }
}




// ── Backup directory ───────────────────────────────────────────────────────────
const backupDir = path.join(__dirname, '../backups');
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

const dbPath         = path.join(__dirname, '../cardledger.db');
const lastBackupFile = path.join(backupDir, '.last-backup');
const uploadsZipPath = path.join(backupDir, 'uploads-backup.zip');

function getLastBackupTime() {
  try { return fs.readFileSync(lastBackupFile, 'utf8').trim(); } catch { return null; }
}

// ── Pure-Node ZIP writer (no external dependencies) ───────────────────────────
// Writes a valid ZIP archive containing all files in a directory.
function buildUploadsZip(srcDir, destZip) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(srcDir)) { resolve(); return; }

    // Collect all files recursively
    function walk(dir, base) {
      let results = [];
      try {
        fs.readdirSync(dir).forEach(f => {
          const full = path.join(dir, f);
          const rel  = base ? `${base}/${f}` : f;
          const stat = fs.statSync(full);
          if (stat.isDirectory()) results = results.concat(walk(full, rel));
          else results.push({ full, rel, size: stat.size, mtime: stat.mtime });
        });
      } catch {}
      return results;
    }

    const files = walk(srcDir, 'uploads');
    if (!files.length) { resolve(); return; }

    // ZIP format constants
    const LOCAL_FILE_HEADER  = 0x04034b50;
    const CENTRAL_DIR_HEADER = 0x02014b50;
    const END_OF_CENTRAL_DIR = 0x06054b50;

    function dosDateTime(d) {
      const date = ((d.getFullYear()-1980)<<9)|((d.getMonth()+1)<<5)|d.getDate();
      const time = (d.getHours()<<11)|(d.getMinutes()<<5)|(Math.floor(d.getSeconds()/2));
      return { date, time };
    }

    function crc32(buf) {
      const table = crc32.table || (crc32.table = (() => {
        const t = new Uint32Array(256);
        for (let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[i]=c;}
        return t;
      })());
      let c = 0xFFFFFFFF;
      for (let i=0;i<buf.length;i++) c = table[(c^buf[i])&0xFF]^(c>>>8);
      return (c^0xFFFFFFFF)>>>0;
    }

    try {
      const parts = [];       // local file entry buffers
      const centralDir = [];  // central directory entry buffers
      let offset = 0;

      for (const file of files) {
        const nameBytes = Buffer.from(file.rel, 'utf8');
        const data      = fs.readFileSync(file.full);
        const crc       = crc32(data);
        const { date, time } = dosDateTime(file.mtime);

        // Local file header
        const lhSize = 30 + nameBytes.length;
        const lh = Buffer.alloc(lhSize);
        lh.writeUInt32LE(LOCAL_FILE_HEADER, 0);
        lh.writeUInt16LE(20, 4);   // version needed
        lh.writeUInt16LE(0, 6);    // flags
        lh.writeUInt16LE(0, 8);    // compression: stored (0)
        lh.writeUInt16LE(time, 10);
        lh.writeUInt16LE(date, 12);
        lh.writeUInt32LE(crc, 14);
        lh.writeUInt32LE(data.length, 18); // compressed size
        lh.writeUInt32LE(data.length, 22); // uncompressed size
        lh.writeUInt16LE(nameBytes.length, 26);
        lh.writeUInt16LE(0, 28);   // extra field length
        nameBytes.copy(lh, 30);

        parts.push(lh, data);

        // Central directory entry
        const cd = Buffer.alloc(46 + nameBytes.length);
        cd.writeUInt32LE(CENTRAL_DIR_HEADER, 0);
        cd.writeUInt16LE(20, 4);   // version made by
        cd.writeUInt16LE(20, 6);   // version needed
        cd.writeUInt16LE(0, 8);    // flags
        cd.writeUInt16LE(0, 10);   // compression
        cd.writeUInt16LE(time, 12);
        cd.writeUInt16LE(date, 14);
        cd.writeUInt32LE(crc, 16);
        cd.writeUInt32LE(data.length, 20);
        cd.writeUInt32LE(data.length, 24);
        cd.writeUInt16LE(nameBytes.length, 28);
        cd.writeUInt16LE(0, 30);   // extra
        cd.writeUInt16LE(0, 32);   // comment
        cd.writeUInt16LE(0, 34);   // disk start
        cd.writeUInt16LE(0, 36);   // internal attr
        cd.writeUInt32LE(0, 38);   // external attr
        cd.writeUInt32LE(offset, 42); // local header offset
        nameBytes.copy(cd, 46);

        centralDir.push(cd);
        offset += lhSize + data.length;
      }

      const cdBuf    = Buffer.concat(centralDir);
      const eocd     = Buffer.alloc(22);
      eocd.writeUInt32LE(END_OF_CENTRAL_DIR, 0);
      eocd.writeUInt16LE(0, 4);
      eocd.writeUInt16LE(0, 6);
      eocd.writeUInt16LE(files.length, 8);
      eocd.writeUInt16LE(files.length, 10);
      eocd.writeUInt32LE(cdBuf.length, 12);
      eocd.writeUInt32LE(offset, 16);
      eocd.writeUInt16LE(0, 20);

      const zipBuf = Buffer.concat([...parts, cdBuf, eocd]);
      fs.writeFileSync(destZip, zipBuf);
      resolve();
    } catch(e) {
      reject(e);
    }
  });
}

// ── Main backup function ───────────────────────────────────────────────────────
// 1) Rolls a timestamped .db copy (keeps 10)
// 2) Replaces the single uploads-backup.zip with a fresh one
async function writeBackup(label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const ts    = new Date().toISOString();

  // 1. DB copy (rolling 10) — use VACUUM INTO so WAL data is included
  const dbDest = path.join(backupDir, `cardledger-${stamp}.db`);
  db.exec(`VACUUM INTO '${dbDest.replace(/\\/g, '/').replace(/'/g, "''")}'`);

  // Prune to 10 most recent .db backups
  const dbFiles = fs.readdirSync(backupDir)
    .filter(f => f.startsWith('cardledger-') && f.endsWith('.db'))
    .sort();
  if (dbFiles.length > 10) {
    dbFiles.slice(0, dbFiles.length - 10).forEach(f => {
      try { fs.unlinkSync(path.join(backupDir, f)); } catch {}
    });
  }

  // 2. Uploads zip — delete old, write fresh
  try {
    if (fs.existsSync(uploadsZipPath)) fs.unlinkSync(uploadsZipPath);
    await buildUploadsZip(uploadDir, uploadsZipPath);
    const zipSize = fs.existsSync(uploadsZipPath)
      ? (fs.statSync(uploadsZipPath).size / 1024 / 1024).toFixed(1) + 'MB'
      : '0MB';
    console.log(`[backup] ${label} → ${path.basename(dbDest)} + uploads-backup.zip (${zipSize})`);
  } catch(e) {
    console.warn('[backup] uploads zip failed:', e.message);
  }

  fs.writeFileSync(lastBackupFile, ts);
  return ts;
}

// ── Auto-backup disabled — manual only via 💾 Backup button ──────────────────

// ── Startup log ───────────────────────────────────────────────────────────────
setTimeout(() => {
  const storageMode = (useS3 && s3Client) ? `S3 (${S3_BUCKET})` : 'local (./uploads)';
  console.log(`[storage] USE_LOCAL_STORAGE = ${USE_LOCAL}`);
  console.log(`[storage] mode: ${storageMode}`);
  if (!USE_LOCAL && !s3Client) {
    console.error('[storage] PROBLEM: USE_LOCAL_STORAGE=false but S3 client failed — uploads will break');
  }
}, 100);


// ── Multer: always buffer in memory so we can stream to S3 or write to disk ───
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

async function storeImage(file) {
  const ext      = path.extname(file.originalname) || '.jpg';
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;

  if (useS3 && s3Client) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const key = `uploads/${filename}`;
    await s3Client.send(new PutObjectCommand({
      Bucket:      S3_BUCKET,
      Key:         key,
      Body:        file.buffer,
      ContentType: file.mimetype,
    }));
    return `${S3_BASE_URL}/${key}`; // full public URL
  } else {
    const dest = path.join(uploadDir, filename);
    fs.writeFileSync(dest, file.buffer);
    return `/uploads/${filename}`;
  }
}


// ── Database setup ─────────────────────────────────────────────────────────────
const db = new DB(path.join(__dirname, '../cardledger.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS cards (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT    NOT NULL,
    is_graded         INTEGER DEFAULT 0,
    grading_company   TEXT,
    grade             TEXT,
    condition_val     TEXT,
    buy_price         REAL    DEFAULT 0,
    market_at_purchase REAL   DEFAULT 0,
    current_market    REAL    DEFAULT 0,
    status            TEXT    DEFAULT 'in_stock',
    transaction_id    INTEGER,
    sale_price        REAL,
    created_at        TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    type           TEXT NOT NULL,
    date           TEXT NOT NULL,
    cash_in        REAL DEFAULT 0,
    cash_out       REAL DEFAULT 0,
    notes          TEXT,
    market_profit  REAL,
    created_at     TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tx_cards_out (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER NOT NULL,
    card_id        INTEGER,
    name           TEXT,
    grade          TEXT,
    is_graded      INTEGER DEFAULT 0,
    current_market REAL,
    sale_price     REAL
  );

  CREATE TABLE IF NOT EXISTS tx_cards_in (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id     INTEGER NOT NULL,
    name               TEXT,
    is_graded          INTEGER DEFAULT 0,
    grading_company    TEXT,
    grade              TEXT,
    condition_val      TEXT,
    buy_price          REAL DEFAULT 0,
    market_at_purchase REAL DEFAULT 0,
    current_market     REAL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS tx_images (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER NOT NULL,
    url            TEXT
  );
`);

// ── Migrations (safe to run on existing DBs) ──────────────────────────────────
try { db.exec(`ALTER TABLE transactions ADD COLUMN payment_method TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE transactions ADD COLUMN venmo_amount REAL`); } catch(e) {}
try { db.exec(`ALTER TABLE transactions ADD COLUMN zelle_amount REAL`); } catch(e) {}
try { db.exec(`ALTER TABLE cards ADD COLUMN image_url TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE transactions ADD COLUMN binder_amount REAL`); } catch(e) {}
try { db.exec(`ALTER TABLE transactions ADD COLUMN binder_credit_used INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE binder_inventory ADD COLUMN purchase_price REAL`); } catch(e) {}

// Profiles / equity support
db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT NOT NULL,
    color    TEXT DEFAULT '#f5a623',
    initials TEXT,
    archived INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS card_profiles (
    card_id    INTEGER NOT NULL,
    profile_id INTEGER NOT NULL,
    percentage REAL    NOT NULL,
    PRIMARY KEY (card_id, profile_id)
  );
  CREATE TABLE IF NOT EXISTS equity_defaults (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    owners_json TEXT DEFAULT '[]'
  );
`);
try { db.exec(`ALTER TABLE profiles ADD COLUMN archived INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`INSERT OR IGNORE INTO equity_defaults (id, owners_json) VALUES (1, '[]')`); } catch(e) {}

// ── App settings (key/value store) ────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ── Costs / misc expenses ──────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS costs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT    NOT NULL,
    item        TEXT    NOT NULL,
    amount      REAL    NOT NULL DEFAULT 0,
    notes       TEXT,
    created_at  TEXT    DEFAULT (datetime('now'))
  );
`);

// ── Binder (RareCandy scraper sync) ────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS binder_inventory (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    card_name     TEXT NOT NULL,
    set_name      TEXT,
    set_number    TEXT,
    rarity        TEXT,
    unit_price    REAL    DEFAULT 0,
    quantity      INTEGER DEFAULT 1,
    first_seen_at TEXT    DEFAULT (datetime('now')),
    last_seen_at  TEXT    DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS binder_imports (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    imported_at     TEXT DEFAULT (datetime('now')),
    cards_added     INTEGER DEFAULT 0,
    cards_removed   INTEGER DEFAULT 0,
    qty_increased   INTEGER DEFAULT 0,
    qty_decreased   INTEGER DEFAULT 0,
    cards_unchanged INTEGER DEFAULT 0,
    cost_basis      REAL,
    sale_proceeds   REAL,
    notes           TEXT
  );
`);

app.use(cors());
app.use(express.json());

// Serve uploaded images
app.use('/uploads', express.static(uploadDir));

// Serve React build in production
app.use(express.static(path.join(__dirname, '../client/build')));

// ── Image upload ───────────────────────────────────────────────────────────────
app.post('/api/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  try {
    const url = await storeImage(req.file);
    res.json({ url, storage: useS3 && s3Client ? 's3' : 'local' });
  } catch(err) {
    console.error('[upload]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Storage mode endpoint — tells frontend which mode is active ────────────────
app.get('/api/storage-mode', (req, res) => {
  res.json({
    useLocal: USE_LOCAL,
    s3Ready:  useS3 && !!s3Client,
    bucket:   useS3 ? S3_BUCKET : null,
  });
});

// ── Profiles ───────────────────────────────────────────────────────────────────
app.get('/api/profiles', (req, res) => {
  res.json(db.prepare('SELECT * FROM profiles ORDER BY id').all());
});

app.post('/api/profiles', (req, res) => {
  const { name, color, initials } = req.body;
  const info = db.prepare('INSERT INTO profiles (name, color, initials) VALUES (?, ?, ?)')
    .run(name, color || '#f5a623', initials || null);
  res.json({ id: info.lastInsertRowid });
});

app.put('/api/profiles/:id', (req, res) => {
  const { name, color, initials } = req.body;
  db.prepare('UPDATE profiles SET name=?, color=?, initials=? WHERE id=?')
    .run(name, color, initials || null, req.params.id);
  res.json({ ok: true });
});

app.patch('/api/profiles/:id/archive', (req, res) => {
  const { archived } = req.body;
  db.prepare('UPDATE profiles SET archived=? WHERE id=?').run(archived ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/profiles/:id', (req, res) => {
  db.transaction(() => {
    db.prepare('DELETE FROM card_profiles WHERE profile_id=?').run(req.params.id);
    db.prepare('DELETE FROM profiles WHERE id=?').run(req.params.id);
  })();
  res.json({ ok: true });
});

// ── Equity defaults ────────────────────────────────────────────────────────────
app.get('/api/equity-defaults', (req, res) => {
  const row = db.prepare('SELECT owners_json FROM equity_defaults WHERE id=1').get();
  res.json({ owners: JSON.parse(row?.owners_json || '[]') });
});

app.put('/api/equity-defaults', (req, res) => {
  db.prepare('INSERT OR REPLACE INTO equity_defaults (id, owners_json) VALUES (1, ?)')
    .run(JSON.stringify(req.body.owners || []));
  res.json({ ok: true });
});

// ── App settings ───────────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM app_settings').all();
  const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
  res.json(settings);
});

app.put('/api/settings/:key', (req, res) => {
  const { key } = req.params;
  const { value } = req.body;
  if (value === null || value === undefined || value === '') {
    db.prepare('DELETE FROM app_settings WHERE key=?').run(key);
  } else {
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, String(value));
  }
  res.json({ ok: true });
});

// ── Helpers: save ownership for a card ────────────────────────────────────────
function saveOwnership(cardId, owners) {
  if (!owners || !owners.length) return;
  db.prepare('DELETE FROM card_profiles WHERE card_id=?').run(cardId);
  const stmt = db.prepare('INSERT OR REPLACE INTO card_profiles (card_id, profile_id, percentage) VALUES (?, ?, ?)');
  for (const o of owners) {
    if (o.profileId && o.percentage > 0) stmt.run(cardId, o.profileId, o.percentage);
  }
}

function getOwnership(cardIds, allOwnership) {
  // allOwnership is a flat list of rows from card_profiles joined with profiles
  const result = {};
  for (const id of cardIds) result[id] = [];
  for (const row of allOwnership) {
    if (result[row.card_id] !== undefined) {
      result[row.card_id].push({
        profileId: row.profile_id,
        name: row.name,
        color: row.color,
        initials: row.initials,
        percentage: row.percentage,
      });
    }
  }
  return result;
}

// ── Cards ──────────────────────────────────────────────────────────────────────
app.get('/api/cards', (req, res) => {
  const rows = db.prepare('SELECT * FROM cards ORDER BY id').all();
  const ownership = db.prepare(`
    SELECT cp.*, p.name, p.color, p.initials
    FROM card_profiles cp JOIN profiles p ON p.id = cp.profile_id
  `).all();
  const ownerMap = getOwnership(rows.map(r => r.id), ownership);
  res.json(rows.map(c => ({ ...dbToCard(c), owners: ownerMap[c.id] || [] })));
});

// Delete a single card from inventory (hard delete — in_stock only)
app.delete('/api/cards/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid card id' });

  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  if (card.status !== 'in_stock') {
    return res.status(400).json({ error: 'Only in-stock cards can be deleted' });
  }

  db.transaction(() => {
    db.prepare('DELETE FROM card_profiles WHERE card_id=?').run(id);
    db.prepare('DELETE FROM cards WHERE id = ?').run(id);
  })();
  res.json({ ok: true });
});

app.post('/api/cards', (req, res) => {
  const c = req.body;
  const info = db.prepare(`
    INSERT INTO cards (name, is_graded, grading_company, grade, condition_val,
      buy_price, market_at_purchase, current_market)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    c.name, c.isGraded ? 1 : 0, c.gradingCompany || null, c.grade || null,
    c.condition || null, c.buyPrice, c.marketAtPurchase,
    c.currentMarket || c.marketAtPurchase
  );
  saveOwnership(info.lastInsertRowid, c.owners);
  res.json({ id: info.lastInsertRowid });
});

app.post('/api/cards/batch', (req, res) => {
  const stmt = db.prepare(`
    INSERT INTO cards (name, is_graded, grading_company, grade, condition_val,
      buy_price, market_at_purchase, current_market)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAll = db.transaction(cards => {
    return cards.map(c => {
      const id = stmt.run(
        c.name, c.isGraded ? 1 : 0, c.gradingCompany || null, c.grade || null,
        c.condition || null, c.buyPrice, c.marketAtPurchase,
        c.currentMarket || c.marketAtPurchase
      ).lastInsertRowid;
      saveOwnership(id, c.owners);
      return id;
    });
  });
  const ids = insertAll(req.body);
  res.json({ ids });
});

// Update current market price (inline edit)
app.patch('/api/cards/:id/market', (req, res) => {
  db.prepare('UPDATE cards SET current_market = ? WHERE id = ?')
    .run(req.body.currentMarket, req.params.id);
  res.json({ ok: true });
});

// Update card image only
app.patch('/api/cards/:id/image', (req, res) => {
  db.prepare('UPDATE cards SET image_url = ? WHERE id = ?')
    .run(req.body.imageUrl || null, req.params.id);
  res.json({ ok: true });
});

// Full card update (edit modals)
app.put('/api/cards/:id', (req, res) => {
  const c = req.body;
  db.prepare(`
    UPDATE cards SET name=?, is_graded=?, grading_company=?, grade=?, condition_val=?,
      buy_price=?, market_at_purchase=?, current_market=?, status=?, sale_price=?
    WHERE id=?
  `).run(
    c.name, c.isGraded ? 1 : 0, c.gradingCompany || null, c.grade || null,
    c.condition || null, c.buyPrice, c.marketAtPurchase, c.currentMarket,
    c.status, c.salePrice ?? null, req.params.id
  );
  if (c.owners) saveOwnership(Number(req.params.id), c.owners);
  res.json({ ok: true });
});

// ── Transactions ───────────────────────────────────────────────────────────────
app.get('/api/transactions', (req, res) => {
  const txs  = db.prepare('SELECT * FROM transactions ORDER BY id').all();
  const outs = db.prepare('SELECT * FROM tx_cards_out').all();
  const ins  = db.prepare('SELECT * FROM tx_cards_in').all();
  const imgs = db.prepare('SELECT * FROM tx_images').all();
  // Attach ownership snapshot for cards that went out (so analytics stay correct after profile changes)
  const ownership = db.prepare(`
    SELECT cp.*, p.name, p.color, p.initials
    FROM card_profiles cp JOIN profiles p ON p.id = cp.profile_id
  `).all();

  res.json(txs.map(t => ({
    id: t.id, type: t.type, date: t.date,
    cashIn: t.cash_in, cashOut: t.cash_out,
    notes: t.notes, marketProfit: t.market_profit,
    paymentMethod: t.payment_method || null,
    venmoAmount: t.venmo_amount || null,
    zelleAmount: t.zelle_amount || null,
    binderAmount: t.binder_amount || null,
    binderCreditUsed: t.binder_credit_used === 1,
    imageUrl: (imgs.find(i => i.transaction_id === t.id) || {}).url || null,
    cardsOut: outs.filter(r => r.transaction_id === t.id).map(r => ({
      id: r.card_id, name: r.name, grade: r.grade,
      isGraded: r.is_graded === 1,
      currentMarket: r.current_market, salePrice: r.sale_price,
      // Ownership stays on the card row in card_profiles even after sale — read it here
      owners: r.card_id ? ownership.filter(o => o.card_id === r.card_id).map(o => ({
        profileId: o.profile_id, name: o.name, color: o.color,
        initials: o.initials, percentage: o.percentage,
      })) : [],
    })),
    cardsIn: ins.filter(r => r.transaction_id === t.id).map(r => {
      // Find the inventory card that came in via this transaction (regardless of current status)
      const card = db.prepare(
        `SELECT id FROM cards WHERE transaction_id=? AND lower(name)=lower(?) LIMIT 1`
      ).get(t.id, r.name);
      const cardId = card ? card.id : null;
      const cardOwners = cardId ? ownership.filter(o => o.card_id === cardId).map(o => ({
        profileId: o.profile_id, name: o.name, color: o.color,
        initials: o.initials, percentage: o.percentage,
      })) : [];
      return {
        cardId, // include the actual inventory card ID
        name: r.name, isGraded: r.is_graded === 1,
        gradingCompany: r.grading_company, grade: r.grade,
        condition: r.condition_val, buyPrice: r.buy_price,
        marketAtPurchase: r.market_at_purchase, currentMarket: r.current_market,
        owners: cardOwners,
      };
    }),
  })));
});

app.post('/api/transactions', (req, res) => {
  const t = req.body;

  const run = db.transaction(() => {
    const txId = db.prepare(`
      INSERT INTO transactions (type, date, cash_in, cash_out, notes, market_profit, payment_method, venmo_amount, zelle_amount, binder_amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(t.type, t.date, t.cashIn, t.cashOut, t.notes || null, t.marketProfit, t.paymentMethod || null, t.venmoAmount || null, t.zelleAmount || null, t.binderAmount || null).lastInsertRowid;

    if (t.imageUrl) {
      db.prepare('INSERT INTO tx_images (transaction_id, url) VALUES (?, ?)')
        .run(txId, t.imageUrl);
    }

    for (const co of t.cardsOut) {
      db.prepare(`
        INSERT INTO tx_cards_out (transaction_id, card_id, name, grade, is_graded, current_market, sale_price)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(txId, co.id, co.name, co.grade || null, co.isGraded ? 1 : 0, co.currentMarket, co.salePrice);

      db.prepare('UPDATE cards SET status=?, transaction_id=?, sale_price=? WHERE id=?')
        .run(t.type === 'sale' ? 'sold' : 'traded', txId, co.salePrice, co.id);
      // ownership stays in card_profiles — intentionally NOT deleted on sale
    }

    for (const ci of t.cardsIn) {
      db.prepare(`
        INSERT INTO tx_cards_in (transaction_id, name, is_graded, grading_company, grade,
          condition_val, buy_price, market_at_purchase, current_market)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(txId, ci.name, ci.isGraded ? 1 : 0, ci.gradingCompany || null, ci.grade || null,
             ci.condition || null, ci.buyPrice, ci.marketAtPurchase, ci.currentMarket);

      // Cards coming in via trade/buy enter inventory with their ownership
      const newCardId = db.prepare(`
        INSERT INTO cards (name, is_graded, grading_company, grade, condition_val,
          buy_price, market_at_purchase, current_market, status, transaction_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_stock', ?)
      `).run(ci.name, ci.isGraded ? 1 : 0, ci.gradingCompany || null, ci.grade || null,
             ci.condition || null, ci.buyPrice, ci.marketAtPurchase, ci.currentMarket, txId).lastInsertRowid;
      saveOwnership(newCardId, ci.owners);
    }

    return txId;
  });

  res.json({ id: run() });
});

app.put('/api/transactions/:id', (req, res) => {
  const t  = req.body;
  const id = req.params.id;

  db.transaction(() => {
    db.prepare(`
      UPDATE transactions SET date=?, notes=?, cash_in=?, cash_out=?, market_profit=?, payment_method=?, venmo_amount=?, zelle_amount=?, binder_amount=? WHERE id=?
    `).run(t.date, t.notes || null, t.cashIn, t.cashOut, t.marketProfit, t.paymentMethod || null, t.venmoAmount || null, t.zelleAmount || null, t.binderAmount || null, id);

    db.prepare('DELETE FROM tx_images WHERE transaction_id = ?').run(id);
    if (t.imageUrl) {
      db.prepare('INSERT INTO tx_images (transaction_id, url) VALUES (?, ?)')
        .run(id, t.imageUrl);
    }

    for (const co of t.cardsOut) {
      db.prepare('UPDATE tx_cards_out SET sale_price=? WHERE transaction_id=? AND card_id=?')
        .run(co.salePrice, id, co.id);
      db.prepare('UPDATE cards SET sale_price=? WHERE id=?').run(co.salePrice, co.id);
      // Update ownership for cards that went out (they stay in card_profiles even after sale)
      if (co.owners && co.id) saveOwnership(co.id, co.owners);
    }

    // Update ownership for cards that came in via trade/buy
    if (t.cardsIn && t.cardsIn.length) {
      for (const ci of t.cardsIn) {
        const cardId = ci.cardId || ci._cardId;
        if (cardId && ci.owners && ci.owners.length) saveOwnership(cardId, ci.owners);
      }
    }
  })();

  res.json({ ok: true });
});

// Undo a transaction: put cards back in stock and remove trade/buy-ins
app.post('/api/transactions/:id/undo', (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid transaction id' });

  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });

  db.transaction(() => {
    // 1) Revert cards that went out back to in_stock
    const outs = db.prepare('SELECT * FROM tx_cards_out WHERE transaction_id = ?').all(id);
    for (const o of outs) {
      if (o.card_id != null) {
        db.prepare(`
          UPDATE cards SET status='in_stock', transaction_id=NULL, sale_price=NULL WHERE id=?
        `).run(o.card_id);
      }
    }

    // 2) Remove cards that came in via this transaction (and their ownership)
    const tradeIns = db.prepare('SELECT id FROM cards WHERE transaction_id = ?').all(id);
    for (const c of tradeIns) {
      db.prepare('DELETE FROM card_profiles WHERE card_id=?').run(c.id);
    }
    db.prepare('DELETE FROM cards WHERE transaction_id = ?').run(id);

    // 3) Clean up all linked records including images
    db.prepare('DELETE FROM tx_cards_out WHERE transaction_id = ?').run(id);
    db.prepare('DELETE FROM tx_cards_in WHERE transaction_id = ?').run(id);
    db.prepare('DELETE FROM tx_images WHERE transaction_id = ?').run(id);
    db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
  })();

  res.json({ ok: true });
});

// ── CSV Export ─────────────────────────────────────────────────────────────────
// Helper: resolve image value for CSV export.
// S3 images are already full https:// URLs. Local paths get the server origin prepended.
function resolveImageForExport(val, req) {
  if (!val) return '';
  if (val.startsWith('http')) return val; // already a full URL (S3 public or external)
  if (val.startsWith('/')) return `${req.protocol}://${req.get('host')}${val}`; // local
  return val;
}

app.get('/api/export/inventory.csv', async (req, res) => {
  const cards = db.prepare('SELECT * FROM cards ORDER BY status, id').all();
  const rows  = cards.map(c => ({
    ID:                  c.id,
    Name:                c.name,
    Graded:              c.is_graded ? 'Yes' : 'No',
    'Grading Company':   c.grading_company || '',
    Grade:               c.grade || '',
    Condition:           c.condition_val || '',
    'Buy Price':         c.buy_price.toFixed(2),
    'Market @ Purchase': c.market_at_purchase.toFixed(2),
    'Current Market':    c.current_market.toFixed(2),
    'Intake %':          c.market_at_purchase > 0
                           ? ((c.buy_price / c.market_at_purchase) * 100).toFixed(1) + '%' : '',
    Status:              c.status,
    'Sale Price':        c.sale_price != null ? c.sale_price.toFixed(2) : '',
    'Sale %':            c.sale_price && c.current_market > 0
                           ? ((c.sale_price / c.current_market) * 100).toFixed(1) + '%' : '',
    'Gain/Loss':         (c.current_market - c.buy_price).toFixed(2),
    'Image URL':         resolveImageForExport(c.image_url, req),
  }));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="cardledger-inventory.csv"');
  res.send(toCSV(rows));
});

app.get('/api/export/transactions.csv', (req, res) => {
  const txs   = db.prepare('SELECT * FROM transactions ORDER BY date, id').all();
  const outs  = db.prepare('SELECT * FROM tx_cards_out').all();
  const ins   = db.prepare('SELECT * FROM tx_cards_in').all();
  const imgs  = db.prepare('SELECT * FROM tx_images').all();
  const cards = db.prepare('SELECT id, image_url FROM cards').all();
  const cardImgMap = Object.fromEntries(cards.map(c => [c.id, c.image_url || '']));

  const rows = txs.map(t => {
    const out   = outs.filter(r => r.transaction_id === t.id);
    const in_   = ins.filter(r => r.transaction_id === t.id);
    const txImg = (imgs.find(i => i.transaction_id === t.id) || {}).url || '';
    const cardImgs = out.map(r => r.card_id ? cardImgMap[r.card_id] || '' : '').filter(Boolean);
    return {
      ID:                  t.id,
      Type:                t.type,
      Date:                t.date,
      Notes:               t.notes || '',
      'Cards Out':         out.map(r => `${r.name}${r.grade ? ' ['+r.grade+']' : ''}`).join('; '),
      'Cards In':          in_.map(r => `${r.name}${r.grade ? ' ['+r.grade+']' : ''}`).join('; '),
      'Cash In':           t.cash_in.toFixed(2),
      'Cash Out':          t.cash_out.toFixed(2),
      'Net Cash':          (t.cash_in - t.cash_out).toFixed(2),
      'Mkt Profit':        t.market_profit != null ? t.market_profit.toFixed(2) : '',
      'Cards Sold At':     out.map(r => r.sale_price != null ? r.sale_price.toFixed(2) : '').join('; '),
      'Transaction Image': resolveImageForExport(txImg, req),
      'Card Images':       cardImgs.map(k => resolveImageForExport(k, req)).join('; '),
    };
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="cardledger-transactions.csv"');
  res.send(toCSV(rows));
});


// ── Helpers ────────────────────────────────────────────────────────────────────
function dbToCard(c) {
  return {
    id: c.id, name: c.name,
    isGraded: c.is_graded === 1,
    gradingCompany: c.grading_company, grade: c.grade,
    condition: c.condition_val,
    buyPrice: c.buy_price,
    marketAtPurchase: c.market_at_purchase,
    currentMarket: c.current_market,
    status: c.status,
    transactionId: c.transaction_id,
    salePrice: c.sale_price,
    imageUrl: c.image_url || null,
  };
}

function toCSV(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape  = v => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map(r => headers.map(h => escape(r[h])).join(','))].join('\r\n');
}

// ── Backup endpoints ───────────────────────────────────────────────────────────
app.get('/api/backup/status', (req, res) => {
  const lastBackup = getLastBackupTime();
  const dbFiles = fs.readdirSync(backupDir)
    .filter(f => f.startsWith('cardledger-') && f.endsWith('.db'))
    .sort();
  const uploadsZipExists = fs.existsSync(uploadsZipPath);
  const uploadsZipMB = uploadsZipExists
    ? (fs.statSync(uploadsZipPath).size / 1024 / 1024).toFixed(1)
    : null;
  const uploadsMB = (du(uploadDir) / 1024 / 1024).toFixed(1);
  res.json({ lastBackup, dbCount: dbFiles.length, uploadsZipMB, uploadsMB });
});

function du(dir) {
  let total = 0;
  try {
    fs.readdirSync(dir).forEach(f => {
      const p = path.join(dir, f);
      try { const s = fs.statSync(p); total += s.isDirectory() ? du(p) : s.size; } catch {}
    });
  } catch {}
  return total;
}

app.post('/api/backup/now', async (req, res) => {
  try {
    const ts = await writeBackup('manual');
    res.json({ ok: true, lastBackup: ts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download latest DB backup
app.get('/api/backup/download/db', (req, res) => {
  const files = fs.readdirSync(backupDir)
    .filter(f => f.startsWith('cardledger-') && f.endsWith('.db'))
    .sort();
  if (!files.length) return res.status(404).json({ error: 'No DB backup found' });
  res.download(path.join(backupDir, files[files.length - 1]), files[files.length - 1]);
});

// Download uploads zip
app.get('/api/backup/download/uploads', (req, res) => {
  if (!fs.existsSync(uploadsZipPath)) return res.status(404).json({ error: 'No uploads backup found — trigger a backup first' });
  res.download(uploadsZipPath, 'uploads-backup.zip');
});

// ── Costs endpoints ────────────────────────────────────────────────────────────
app.get('/api/costs', (req, res) => {
  res.json(db.prepare('SELECT * FROM costs ORDER BY date DESC, id DESC').all());
});

app.post('/api/costs', (req, res) => {
  const { date, item, amount, notes } = req.body;
  const info = db.prepare('INSERT INTO costs (date, item, amount, notes) VALUES (?, ?, ?, ?)')
    .run(date, item, amount || 0, notes || null);
  res.json({ id: info.lastInsertRowid });
});

app.put('/api/costs/:id', (req, res) => {
  const { date, item, amount, notes } = req.body;
  db.prepare('UPDATE costs SET date=?, item=?, amount=?, notes=? WHERE id=?')
    .run(date, item, amount || 0, notes || null, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/costs/:id', (req, res) => {
  db.prepare('DELETE FROM costs WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Alt.xyz link lookup ────────────────────────────────────────────────────────
const https = require('https');
const http  = require('http');

app.get('/api/alt-test', (req, res) => {
  res.json({ ok: true, message: 'alt-lookup route is reachable' });
});

app.get('/api/alt-lookup', (req, res) => {
  const { url } = req.query;
  console.log('[alt-lookup] received request, url:', url ? url.slice(0,80) : 'MISSING');
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  // ── Rare Candy: parse card name directly from URL path ────────────────────
  // URL pattern: /pokemon/sets/<set-name>/<card-slug>/<id>
  // e.g. /pokemon/sets/double-blaze/wigglytuff-63/FUYYrM7...
  if (url.includes('rarecandy.com')) {
    try {
      const pathParts = url.replace(/\?.*$/, '').split('/').filter(Boolean);
      // Find "sets" in path, card slug is two positions after
      const setsIdx = pathParts.indexOf('sets');
      if (setsIdx !== -1 && pathParts.length > setsIdx + 2) {
        const setSlug  = pathParts[setsIdx + 1]; // e.g. "double-blaze"
        const cardSlug = pathParts[setsIdx + 2]; // e.g. "wigglytuff-63"

        // Convert slugs: "wigglytuff-63" → "Wigglytuff 63"
        function slugToTitle(s) {
          return s.split('-').map((w,i) => {
            // Keep numbers as-is, capitalize words
            if (/^\d+$/.test(w)) return w;
            return w.charAt(0).toUpperCase() + w.slice(1);
          }).join(' ');
        }

        const cardName = slugToTitle(cardSlug);
        const setName  = slugToTitle(setSlug);

        console.log(`[alt-lookup] Rare Candy path parse → "${cardName}" / "${setName}"`);
        return res.json({
          cardName: `${cardName} ${setName}`,
          description: `${cardName} from ${setName}`,
          imageUrl: '',
          sourceUrl: url,
        });
      }
    } catch(e) {
      console.warn('[alt-lookup] Rare Candy path parse failed:', e.message);
    }
  }

  function get(targetUrl, redirects) {
    if (redirects <= 0) return Promise.reject(new Error('Too many redirects'));
    return new Promise((resolve, reject) => {
      const lib = targetUrl.startsWith('https') ? https : http;
      const r = lib.get(targetUrl, {
        headers: {
          'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 12000,
      }, response => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          const loc = response.headers.location;
          // Handle relative redirects without URL constructor
          const next = loc.startsWith('http') ? loc : targetUrl.replace(/^(https?:\/\/[^/]+).*$/, '$1') + (loc.startsWith('/') ? '' : '/') + loc;
          return resolve(get(next, redirects - 1));
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', c => body += c);
        response.on('end', () => resolve({ status: response.statusCode, body, finalUrl: targetUrl }));
      });
      r.on('error', reject);
      r.on('timeout', () => { r.destroy(); reject(new Error('Request timed out after 12s')); });
    });
  }

  get(url, 8)
    .then(({ body, finalUrl, status }) => {
      // Extract OG/twitter meta tags
      function meta(attr, val) {
        const re1 = new RegExp('<meta[^>]+' + attr + '=["\']' + val + '["\'][^>]+content=["\']([^"\']+)["\']', 'i');
        const re2 = new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]+' + attr + '=["\']' + val + '["\']', 'i');
        const m = body.match(re1) || body.match(re2);
        return m ? m[1].replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&quot;/g,'"').trim() : '';
      }

      const title   = meta('property','og:title')       || meta('name','twitter:title')       || (body.match(/<title[^>]*>([^<]+)<\/title>/i)||[])[1] || '';
      const desc    = meta('property','og:description')  || meta('name','twitter:description') || '';
      const imgUrl  = meta('property','og:image')        || meta('name','twitter:image')       || '';

      const cardName = title
        .replace(/\s*[·•|–—]\s*(Alt|alt\.xyz|Marketplace|Shop|Rare\s*Candy|rarecandystore\.com|Rare Candy Store).*$/i, '')
        .replace(/\s*\|.*$/, '')
        .replace(/\s*-\s*Rare\s*Candy.*$/i, '')
        .trim();

      if (!cardName) {
        return res.json({
          error: 'No card name found',
          status,
          finalUrl,
          tip: 'Try the full alt.xyz product URL instead of the short link',
          bodySnippet: body.slice(0, 800),
        });
      }

      res.json({ cardName, description: desc, imageUrl: imgUrl, sourceUrl: finalUrl });
    })
    .catch(err => {
      console.error('[alt-lookup]', err.message);
      res.status(500).json({ error: err.message });
    });
});

// ── Binder helpers ─────────────────────────────────────────────────────────────
function parseCSVRow(line) {
  const result = [];
  let inQuote = false;
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuote && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuote = !inQuote; }
    } else if (c === ',' && !inQuote) {
      result.push(current.trim());
      current = '';
    } else {
      current += c;
    }
  }
  result.push(current.trim());
  return result;
}

function parseBinderCSV(csvText) {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCSVRow(lines[0]);
  const cards = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVRow(lines[i]);
    if (cols.length < 2) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = (cols[idx] || '').replace(/^"|"$/g, ''); });
    const qty = parseInt(row['Quantity'] || row['quantity'] || '1', 10) || 1;
    const rawPrice = parseFloat(row['Price'] || row['price'] || '0') || 0;
    const unitPrice = qty > 1 ? rawPrice / qty : rawPrice;
    const cardName = row['CardName'] || row['cardname'] || row['card_name'] || '';
    if (!cardName) continue;
    cards.push({
      card_name:  cardName,
      set_name:   row['Set']    || row['set_name']   || '',
      set_number: row['Number'] || row['set_number'] || '',
      rarity:     row['Rarity'] || row['rarity']     || '',
      unit_price: unitPrice,
      quantity:   qty,
    });
  }
  return cards;
}

function binderKey(c) { return `${c.card_name}|${c.set_number}`; }

function computeBinderDiff(newCards) {
  const current = db.prepare('SELECT * FROM binder_inventory').all();
  const currentMap = new Map(current.map(c => [binderKey(c), c]));
  const newMap     = new Map(newCards.map(c => [binderKey(c), c]));

  const added       = [];  // completely new card type
  const removed     = [];  // completely gone card type
  const qtyUp       = [];  // qty increased → delta cards added
  const qtyDown     = [];  // qty decreased → delta cards removed
  const unchanged   = [];

  for (const [key, card] of newMap.entries()) {
    const existing = currentMap.get(key);
    if (!existing) {
      added.push(card);
    } else if (card.quantity > existing.quantity) {
      qtyUp.push({ ...card, prevQuantity: existing.quantity, delta: card.quantity - existing.quantity, existingId: existing.id });
    } else if (card.quantity < existing.quantity) {
      qtyDown.push({ ...card, prevQuantity: existing.quantity, delta: existing.quantity - card.quantity, existingId: existing.id, storedUnitPrice: existing.unit_price });
    } else {
      unchanged.push({ ...card, existingId: existing.id });
    }
  }
  for (const [key, card] of currentMap.entries()) {
    if (!newMap.has(key)) removed.push({ ...card, storedUnitPrice: card.unit_price });
  }

  return { added, removed, qtyUp, qtyDown, unchanged };
}

// GET /api/binder/inventory
app.get('/api/binder/inventory', (req, res) => {
  const cards   = db.prepare('SELECT * FROM binder_inventory ORDER BY card_name').all();
  const imports = db.prepare('SELECT * FROM binder_imports ORDER BY imported_at DESC LIMIT 30').all();
  res.json({ cards, imports });
});

// POST /api/binder/preview  — parse CSV, return diff (no DB writes)
app.post('/api/binder/preview', (req, res) => {
  try {
    const csvText = typeof req.body === 'string' ? req.body : (req.body && req.body.csvText);
    if (!csvText) return res.status(400).json({ error: 'No CSV text provided' });
    const newCards = parseBinderCSV(csvText);
    const diff = computeBinderDiff(newCards);
    const totalNewValue = diff.added.reduce((s, c) => s + c.unit_price * c.quantity, 0)
      + diff.qtyUp.reduce((s, c) => s + c.unit_price * c.delta, 0);
    const totalRemovedValue = diff.removed.reduce((s, c) => s + (c.storedUnitPrice || c.unit_price) * c.quantity, 0)
      + diff.qtyDown.reduce((s, c) => s + (c.storedUnitPrice || c.unit_price) * c.delta, 0);
    // Unsettled binder credit — separate in (received) and out (paid) totals
    const binderIn  = db.prepare(`SELECT COALESCE(SUM(binder_amount), 0) as total FROM transactions WHERE binder_credit_used=0 AND binder_amount > 0`).get().total || 0;
    const binderOut = db.prepare(`SELECT COALESCE(SUM(binder_amount), 0) as total FROM transactions WHERE binder_credit_used=0 AND binder_amount < 0`).get().total || 0;
    const binderCredit = binderIn + binderOut; // net (out is negative)
    res.json({ ...diff, totalNewValue, totalRemovedValue, totalParsed: newCards.length, binderCredit, binderIn, binderOut: Math.abs(binderOut) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/binder/import  — apply diff, optionally create ledger transactions
app.post('/api/binder/import', express.json({ limit: '10mb' }), (req, res) => {
  try {
    const { csvText, costBasis, binderCredit, saleProceeds, saleBinder, notes, date, owners } = req.body;
    const newCards = parseBinderCSV(csvText);
    const { added, removed, qtyUp, qtyDown, unchanged } = computeBinderDiff(newCards);
    const txDate = date || new Date().toISOString().split('T')[0];
    const now = new Date().toISOString();

    // All "effective new" cards (new type + qty increase delta)
    const effectiveAdded = [
      ...added,
      ...qtyUp.map(c => ({ ...c, quantity: c.delta })),
    ];
    // All "effective removed" cards
    const effectiveRemoved = [
      ...removed,
      ...qtyDown.map(c => ({ ...c, quantity: c.delta })),
    ];

    db.transaction(() => {
      // ── Settle binder credit balance ─────────────────────────────────────────
      const appliedBinderCredit = parseFloat(req.body.binderCredit) || 0;
      const appliedSaleBinder   = parseFloat(saleBinder) || 0;
      if (appliedBinderCredit !== 0 || appliedSaleBinder !== 0) {
        db.prepare(`UPDATE transactions SET binder_credit_used=1 WHERE binder_credit_used=0 AND binder_amount IS NOT NULL AND binder_amount != 0`).run();
      }
      const totalBasis = (parseFloat(costBasis) || 0) + appliedBinderCredit;

      // ── Update binder_inventory ──────────────────────────────────────────────
      // Compute per-unit purchase price for new cards (prorated from cost basis)
      const totalNewValue = effectiveAdded.reduce((s, c) => s + c.unit_price * c.quantity, 0);
      for (const card of added) {
        const proportion = totalNewValue > 0 ? (card.unit_price * card.quantity) / totalNewValue : 1 / Math.max(effectiveAdded.length, 1);
        const lotCost = totalBasis * proportion;
        const purchasePrice = card.quantity > 0 ? lotCost / card.quantity : lotCost;
        db.prepare(`INSERT INTO binder_inventory (card_name, set_name, set_number, rarity, unit_price, quantity, purchase_price, first_seen_at, last_seen_at)
                    VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(card.card_name, card.set_name, card.set_number, card.rarity, card.unit_price, card.quantity, totalBasis > 0 ? purchasePrice : null, now, now);
      }
      for (const card of qtyUp) {
        // Weighted average purchase price: existing cost + new prorated cost
        const existing = db.prepare('SELECT purchase_price, quantity FROM binder_inventory WHERE id=?').get(card.existingId);
        const oldPP = existing?.purchase_price || 0;
        const oldQty = existing?.quantity || card.prevQuantity;
        const proportion = totalNewValue > 0 ? (card.unit_price * card.delta) / totalNewValue : 1 / Math.max(effectiveAdded.length, 1);
        const newLotCost = totalBasis * proportion;
        const newPP = card.delta > 0 ? newLotCost / card.delta : 0;
        const avgPP = totalBasis > 0 ? ((oldPP * oldQty) + (newPP * card.delta)) / card.quantity : oldPP;
        db.prepare('UPDATE binder_inventory SET unit_price=?, quantity=?, purchase_price=?, last_seen_at=? WHERE id=?')
          .run(card.unit_price, card.quantity, avgPP > 0 ? avgPP : existing?.purchase_price || null, now, card.existingId);
      }
      for (const card of [...qtyDown, ...unchanged]) {
        db.prepare('UPDATE binder_inventory SET unit_price=?, quantity=?, last_seen_at=? WHERE id=?')
          .run(card.unit_price, card.quantity, now, card.existingId);
      }
      for (const card of removed) {
        db.prepare('DELETE FROM binder_inventory WHERE id=?').run(card.id);
      }

      // ── Create BUY transaction for new cards ────────────────────────────────
      if (totalBasis > 0 && effectiveAdded.length > 0) {
        const basis = totalBasis;

        const cashPortion   = parseFloat(costBasis) || 0;
        const binderPortion = appliedBinderCredit;
        const pmParts = [cashPortion > 0 ? 'cash' : null, binderPortion > 0 ? 'binder' : null].filter(Boolean).join(',') || 'binder';
        // market_profit = market value of cards received minus what we paid (cash + binder)
        const buyMarketProfit = totalNewValue - totalBasis;
        const txId = db.prepare(
          `INSERT INTO transactions (type, date, cash_in, cash_out, notes, market_profit, payment_method, binder_amount)
           VALUES (?,?,?,?,?,?,?,?)`
        ).run('buy', txDate, 0, cashPortion,
          notes || `Binder import: ${effectiveAdded.length} new card type(s)` + (binderPortion ? ` (+${binderPortion.toFixed(2)} binder credit)` : ''),
          buyMarketProfit, pmParts,
          binderPortion > 0 ? -binderPortion : null
        ).lastInsertRowid;

        for (const card of effectiveAdded) {
          const proportion   = totalNewValue > 0 ? (card.unit_price * card.quantity) / totalNewValue : 1 / effectiveAdded.length;
          const lotCost      = basis * proportion;
          const unitCost     = card.quantity > 0 ? lotCost / card.quantity : lotCost;

          for (let q = 0; q < card.quantity; q++) {
            const cardId = db.prepare(
              `INSERT INTO cards (name, condition_val, buy_price, market_at_purchase, current_market, status, transaction_id)
               VALUES (?,?,?,?,?,?,?)`
            ).run(card.card_name, 'Near Mint', unitCost, card.unit_price, card.unit_price, 'in_stock', txId).lastInsertRowid;

            if (owners && owners.length > 0) {
              for (const o of owners) {
                db.prepare('INSERT OR REPLACE INTO card_profiles (card_id, profile_id, percentage) VALUES (?,?,?)')
                  .run(cardId, o.profileId, o.percentage);
              }
            }
          }

          db.prepare(
            `INSERT INTO tx_cards_in (transaction_id, name, condition_val, buy_price, market_at_purchase, current_market)
             VALUES (?,?,?,?,?,?)`
          ).run(txId, `${card.card_name}${card.quantity > 1 ? ` ×${card.quantity}` : ''}`,
            'Near Mint', unitCost, card.unit_price, card.unit_price);
        }
      }

      // ── Create SALE transaction for removed cards ──────────────────────────
      const cashProceeds   = parseFloat(saleProceeds) || 0;
      const binderProceeds = parseFloat(saleBinder)   || 0;
      const totalSaleProceeds = cashProceeds + binderProceeds;
      if (totalSaleProceeds > 0 && effectiveRemoved.length > 0) {
        const proceeds = totalSaleProceeds;
        const totalRemovedValue = effectiveRemoved.reduce((s, c) => s + (c.storedUnitPrice || c.unit_price) * c.quantity, 0);
        const pmMethods = [cashProceeds > 0 ? 'cash' : null, binderProceeds > 0 ? 'binder' : null].filter(Boolean).join(',') || 'cash';

        // Calculate market profit: total sale proceeds minus cost basis of removed cards
        const removedCostBasis = effectiveRemoved.reduce((s, c) => {
          const matchCards = db.prepare('SELECT buy_price FROM cards WHERE name=? AND status=? LIMIT ?')
            .all(c.card_name, 'in_stock', c.quantity);
          return s + matchCards.reduce((ss, mc) => ss + (mc.buy_price || 0), 0);
        }, 0);
        const saleMarketProfit = proceeds - removedCostBasis;

        const txId = db.prepare(
          `INSERT INTO transactions (type, date, cash_in, cash_out, notes, market_profit, payment_method, binder_amount)
           VALUES (?,?,?,?,?,?,?,?)`
        ).run('sale', txDate, cashProceeds, 0,
          notes || `Binder removal: ${effectiveRemoved.length} card type(s)`, saleMarketProfit, pmMethods,
          binderProceeds > 0 ? binderProceeds : null
        ).lastInsertRowid;

        for (const card of effectiveRemoved) {
          const storedPrice    = card.storedUnitPrice || card.unit_price;
          const proportion     = totalRemovedValue > 0 ? (storedPrice * card.quantity) / totalRemovedValue : 1 / effectiveRemoved.length;
          const cardSaleTotal  = proceeds * proportion;
          const unitSalePrice  = card.quantity > 0 ? cardSaleTotal / card.quantity : cardSaleTotal;

          const matchingCards = db.prepare(
            `SELECT id, buy_price FROM cards WHERE name=? AND status='in_stock' LIMIT ?`
          ).all(card.card_name, card.quantity);

          for (const mc of matchingCards) {
            db.prepare(`UPDATE cards SET status='sold', sale_price=?, transaction_id=? WHERE id=?`)
              .run(unitSalePrice, txId, mc.id);
            if (owners && owners.length > 0) {
              for (const o of owners) {
                db.prepare('INSERT OR REPLACE INTO card_profiles (card_id, profile_id, percentage) VALUES (?,?,?)')
                  .run(mc.id, o.profileId, o.percentage);
              }
            }
            db.prepare(`INSERT INTO tx_cards_out (transaction_id, card_id, name, current_market, sale_price)
                        VALUES (?,?,?,?,?)`)
              .run(txId, mc.id, card.card_name, card.unit_price, unitSalePrice);
          }

          // If fewer in-stock than we expect, log ghost entries for the remainder
          const matched = matchingCards.length;
          const remaining = card.quantity - matched;
          for (let r = 0; r < remaining; r++) {
            db.prepare(`INSERT INTO tx_cards_out (transaction_id, card_id, name, current_market, sale_price)
                        VALUES (?,?,?,?,?)`)
              .run(txId, null, card.card_name, card.unit_price, unitSalePrice);
          }
        }
      }

      // ── Record import history ───────────────────────────────────────────────
      db.prepare(
        `INSERT INTO binder_imports (imported_at, cards_added, cards_removed, qty_increased, qty_decreased, cards_unchanged, cost_basis, sale_proceeds, notes)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(now, added.length, removed.length, qtyUp.length, qtyDown.length, unchanged.length,
        totalBasis > 0 ? totalBasis : null, saleProceeds || null, notes || null);
    })();

    res.json({ ok: true, added: added.length + qtyUp.length, removed: removed.length + qtyDown.length });
  } catch (e) {
    console.error('[binder-import]', e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n⚡ CardLedger running`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://<your-pc-ip>:${PORT}  ← use this on your phone\n`);
});

// Catch-all → serve React app (must be last)
app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, '../client/build/index.html'))
);
