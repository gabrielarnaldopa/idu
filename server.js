/**
 * Sistema de Alertas Médicas
 * Backend: Express + WebSockets + SQLite
 *
 * Endpoints principales:
 *   POST /api/login                -> login de usuarios
 *   POST /api/logout               -> logout
 *   GET  /api/me                   -> sesión actual
 *   GET  /api/alerts               -> lista de alertas (requiere login)
 *   PATCH /api/alerts/:id          -> actualizar estado de la alerta
 *   DELETE /api/alerts/:id         -> eliminar alerta
 *   POST /api/webhook/alert        -> endpoint público para n8n (protegido con API key)
 *
 * WebSocket: /ws  -> difunde nuevas alertas en tiempo real
 */

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const WEBHOOK_API_KEY = process.env.WEBHOOK_API_KEY || 'cambia-esta-clave-n8n-12345';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
// DB_PATH permite apuntar a un volumen persistente en Railway (p.ej. /data/alerts.db)
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');

// --------------------------------------------------------------------------
// Base de datos SQLite
// --------------------------------------------------------------------------
// Si la ruta apunta a un directorio que no existe (volumen montado), lo creamos
const dbDir = path.dirname(DB_PATH);
if (!require('fs').existsSync(dbDir)) {
  require('fs').mkdirSync(dbDir, { recursive: true });
}
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'medico',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    patient_name TEXT,
    patient_age TEXT,
    location TEXT,
    description TEXT,
    symptoms TEXT,
    vital_signs TEXT,
    source TEXT DEFAULT 'n8n',
    status TEXT DEFAULT 'pendiente',
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Usuarios por defecto (solo si no existen)
const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
if (userCount === 0) {
  const insert = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)');
  insert.run('admin', bcrypt.hashSync('admin123', 10), 'admin');
  insert.run('medico', bcrypt.hashSync('medico123', 10), 'medico');
  insert.run('enfermeria', bcrypt.hashSync('enfermeria123', 10), 'enfermeria');
  console.log('[DB] Usuarios por defecto creados:');
  console.log('     admin / admin123');
  console.log('     medico / medico123');
  console.log('     enfermeria / enfermeria123');
}

// --------------------------------------------------------------------------
// Tipos de alerta permitidos
// --------------------------------------------------------------------------
const VALID_TYPES = ['urgente', 'atencion_necesaria', 'emergencia', 'reanimacion', 'consultas'];

// --------------------------------------------------------------------------
// Express
// --------------------------------------------------------------------------
const app = express();
const server = http.createServer(app);

// Railway / Heroku / Nginx: confiar en el primer proxy para que req.secure funcione
app.set('trust proxy', 1);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: IS_PRODUCTION,       // HTTPS obligatorio en producción (Railway lo da)
    sameSite: IS_PRODUCTION ? 'lax' : 'lax',
    maxAge: 1000 * 60 * 60 * 8   // 8 horas
  }
}));

// Middleware para rutas protegidas
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ error: 'No autorizado' });
}

// --------------------------------------------------------------------------
// Auth
// --------------------------------------------------------------------------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Faltan credenciales' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role } });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  res.json({
    id: req.session.userId,
    username: req.session.username,
    role: req.session.role
  });
});

// --------------------------------------------------------------------------
// Alertas (protegido por login)
// --------------------------------------------------------------------------
app.get('/api/alerts', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 500').all();
  const alerts = rows.map(r => ({
    ...r,
    metadata: r.metadata ? safeJSON(r.metadata) : null
  }));
  res.json(alerts);
});

app.patch('/api/alerts/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status } = req.body || {};
  const allowed = ['pendiente', 'en_atencion', 'resuelta'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Estado no válido' });
  }
  const result = db.prepare(`
    UPDATE alerts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(status, id);
  if (result.changes === 0) return res.status(404).json({ error: 'Alerta no encontrada' });

  const updated = db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
  broadcast({ event: 'alert_updated', alert: { ...updated, metadata: safeJSON(updated.metadata) } });
  res.json({ ok: true });
});

app.delete('/api/alerts/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const result = db.prepare('DELETE FROM alerts WHERE id = ?').run(id);
  if (result.changes === 0) return res.status(404).json({ error: 'Alerta no encontrada' });
  broadcast({ event: 'alert_deleted', id });
  res.json({ ok: true });
});

// --------------------------------------------------------------------------
// Webhook para n8n (protegido con API key, NO requiere sesión)
// --------------------------------------------------------------------------
app.post('/api/webhook/alert', (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (apiKey !== WEBHOOK_API_KEY) {
    return res.status(401).json({ error: 'API key inválida' });
  }

  const body = req.body || {};
  const rawType = String(body.type || '').toLowerCase().replace(/\s+/g, '_').replace('ó', 'o').replace('á', 'a');
  const type = VALID_TYPES.includes(rawType) ? rawType : null;

  if (!type) {
    return res.status(400).json({
      error: 'Tipo de alerta inválido',
      valid_types: VALID_TYPES
    });
  }

  const alert = {
    type,
    title: body.title || defaultTitle(type),
    patient_name: body.patient_name || body.paciente || null,
    patient_age: body.patient_age || body.edad || null,
    location: body.location || body.ubicacion || null,
    description: body.description || body.descripcion || body.mensaje || '',
    symptoms: body.symptoms || body.sintomas || null,
    vital_signs: body.vital_signs || body.signos_vitales || null,
    source: body.source || 'n8n-chatbot',
    metadata: body.metadata ? JSON.stringify(body.metadata) : null
  };

  const result = db.prepare(`
    INSERT INTO alerts (type, title, patient_name, patient_age, location, description, symptoms, vital_signs, source, metadata)
    VALUES (@type, @title, @patient_name, @patient_age, @location, @description, @symptoms, @vital_signs, @source, @metadata)
  `).run(alert);

  const saved = db.prepare('SELECT * FROM alerts WHERE id = ?').get(result.lastInsertRowid);
  const alertOut = { ...saved, metadata: safeJSON(saved.metadata) };

  broadcast({ event: 'alert_new', alert: alertOut });

  res.json({ ok: true, alert: alertOut });
});

// Sirve los archivos estáticos (frontend)
app.use(express.static(path.join(__dirname, 'public')));

// --------------------------------------------------------------------------
// WebSocket - push en tiempo real al dashboard
// --------------------------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({ event: 'connected' }));
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
function safeJSON(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return str; }
}

function defaultTitle(type) {
  const map = {
    urgente: 'Caso urgente',
    atencion_necesaria: 'Atención necesaria',
    emergencia: 'Emergencia médica',
    reanimacion: 'Reanimación requerida',
    consultas: 'Consulta médica'
  };
  return map[type] || 'Alerta';
}

// --------------------------------------------------------------------------
// Arrancar servidor
// --------------------------------------------------------------------------
server.listen(PORT, () => {
  console.log('');
  console.log('==========================================');
  console.log('  Sistema de Alertas Médicas');
  console.log('==========================================');
  console.log(`  Dashboard:  http://localhost:${PORT}`);
  console.log(`  Webhook:    http://localhost:${PORT}/api/webhook/alert`);
  console.log(`  API Key:    ${WEBHOOK_API_KEY}`);
  console.log('==========================================');
  console.log('');
});
