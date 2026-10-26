const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const db = new Database('skillsphere.db');
const SECRET = 'skillsphere_secret_key';

app.use(express.json());
app.use(express.static(__dirname));

// ---------- Tables ----------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS projects (
  project_id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  budget REAL,
  deadline TEXT,
  status TEXT DEFAULT 'open',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS proposals (
  proposal_id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  freelancer_id INTEGER NOT NULL,
  bid_amount REAL,
  cover_letter TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS milestones (
  milestone_id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  criteria TEXT,
  amount REAL NOT NULL,
  status TEXT DEFAULT 'funded',
  submission TEXT
);
CREATE TABLE IF NOT EXISTS escrow (
  escrow_id INTEGER PRIMARY KEY AUTOINCREMENT,
  milestone_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  status TEXT DEFAULT 'held'
);
CREATE TABLE IF NOT EXISTS trust_scores (
  user_id INTEGER PRIMARY KEY,
  score INTEGER DEFAULT 50,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);`);

try { db.exec('ALTER TABLE projects ADD COLUMN freelancer_id INTEGER'); } catch (e) {}
try { db.exec('ALTER TABLE milestones ADD COLUMN ai_score INTEGER'); } catch (e) {}
try { db.exec('ALTER TABLE milestones ADD COLUMN ai_result TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE milestones ADD COLUMN revisions INTEGER DEFAULT 0'); } catch (e) {}

// ---------- Helpers ----------
function auth(role) {
  return (req, res, next) => {
    try {
      const token = (req.headers.authorization || '').split(' ')[1];
      const user = jwt.verify(token, SECRET);
      if (role && user.role !== role) return res.status(403).json({ error: 'Not allowed.' });
      req.user = user;
      next();
    } catch (e) {
      res.status(401).json({ error: 'Please log in again.' });
    }
  };
}

const STOP = ['with','that','this','from','have','will','must','should','your','and','the','for','are','all'];

// AI feature 1: checks how many required points appear in the submitted work
function aiVerify(criteria, work) {
  const words = (criteria || '').toLowerCase().match(/[a-z]{3,}/g) || [];
  const keys = [...new Set(words.filter(w => !STOP.includes(w)))];
  const text = (work || '').toLowerCase();
  if (!keys.length) return { score: 50, result: 'Needs manual review' };
  const hit = keys.filter(k => text.includes(k)).length;
  let score = Math.round((hit / keys.length) * 100);
  if (text.length < 20) score = Math.min(score, 30);
  return { score, result: score >= 60 ? 'Meets criteria' : 'Needs revision' };
}

// AI feature 2: trust score from past behaviour
function updateTrust(userId) {
  const u = db.prepare('SELECT role FROM users WHERE user_id = ?').get(userId);
  if (!u) return;
  const col = u.role === 'freelancer' ? 'freelancer_id' : 'client_id';
  const rows = db.prepare(
    'SELECT m.status, m.revisions FROM milestones m JOIN projects p ON p.project_id = m.project_id WHERE p.' + col + ' = ?'
  ).all(userId);
  const approved = rows.filter(r => r.status === 'approved').length;
  const revs = rows.reduce((s, r) => s + (r.revisions || 0), 0);
  const penalty = u.role === 'freelancer' ? revs * 5 : 0;
  const score = Math.max(0, Math.min(100, 50 + approved * 10 - penalty));
  db.prepare(
    'INSERT INTO trust_scores (user_id, score) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET score = excluded.score, updated_at = CURRENT_TIMESTAMP'
  ).run(userId, score);
}

function getTrust(userId) {
  const r = db.prepare('SELECT score FROM trust_scores WHERE user_id = ?').get(userId);
  return r ? r.score : 50;
}
require('./features')(app, db, auth, getTrust, updateTrust);
// ---------- Login and register ----------
app.post('/api/register', (req, res) => {
  if (!['client', 'freelancer'].includes(req.body.role)) {
  return res.status(403).json({ error: 'Admin registration is not allowed.' });
}
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'Please fill all fields.' });
  }
  const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(email);
  if (exists) return res.status(400).json({ error: 'This email is already registered.' });

  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)')
    .run(name, email, hash, role);
  res.json({ message: 'Account created. You can log in now.' });
});

app.post('/api/login', (req, res) => {
  const { email, password, role } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Wrong email or password.' });
  }
  if (user.role !== role) {
    return res.status(401).json({ error: 'This account is registered as ' + user.role + '.' });
  }
  const token = jwt.sign({ id: user.user_id, role: user.role }, SECRET, { expiresIn: '1d' });
  res.json({ token, name: user.name, role: user.role });
});

app.get('/api/trust', auth(), (req, res) => res.json({ score: getTrust(req.user.id) }));

// ---------- Projects and proposals ----------
app.post('/api/projects', auth('client'), (req, res) => {
  const { title, description, budget, deadline } = req.body;
  if (!title || !budget) return res.status(400).json({ error: 'Title and budget are required.' });
  db.prepare('INSERT INTO projects (client_id, title, description, budget, deadline) VALUES (?,?,?,?,?)')
    .run(req.user.id, title, description, budget, deadline);
  res.json({ message: 'Project posted.' });
});

app.get('/api/projects', auth(), (req, res) => {
  const rows = req.user.role === 'client'
    ? db.prepare('SELECT * FROM projects WHERE client_id = ? ORDER BY project_id DESC').all(req.user.id)
    : db.prepare("SELECT * FROM projects WHERE status = 'open' OR freelancer_id = ? ORDER BY project_id DESC").all(req.user.id);
  res.json(rows);
});

app.get('/api/projects/:id', auth(), (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE project_id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  if (p.client_id !== req.user.id && p.freelancer_id !== req.user.id) {
    return res.status(403).json({ error: 'Not allowed.' });
  }
  const milestones = db.prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY milestone_id').all(p.project_id);
  res.json({ project: p, milestones });
});

app.post('/api/proposals', auth('freelancer'), (req, res) => {
  const { project_id, bid_amount, cover_letter } = req.body;
  if (!project_id || !bid_amount) return res.status(400).json({ error: 'Bid amount is required.' });
  const dup = db.prepare('SELECT 1 FROM proposals WHERE project_id = ? AND freelancer_id = ?')
    .get(project_id, req.user.id);
  if (dup) return res.status(400).json({ error: 'You already sent a proposal.' });
  db.prepare('INSERT INTO proposals (project_id, freelancer_id, bid_amount, cover_letter) VALUES (?,?,?,?)')
    .run(project_id, req.user.id, bid_amount, cover_letter);
  res.json({ message: 'Proposal sent.' });
});

app.get('/api/projects/:id/proposals', auth('client'), (req, res) => {
  const own = db.prepare('SELECT 1 FROM projects WHERE project_id = ? AND client_id = ?')
    .get(req.params.id, req.user.id);
  if (!own) return res.status(403).json({ error: 'Not allowed.' });
  const rows = db.prepare('SELECT proposal_id, freelancer_id, bid_amount, cover_letter, status FROM proposals WHERE project_id = ?')
    .all(req.params.id);
  res.json(rows.map(r => ({ ...r, trust: getTrust(r.freelancer_id) })).sort((a, b) => b.trust - a.trust));
});

app.post('/api/proposals/:id/accept', auth('client'), (req, res) => {
  const pr = db.prepare('SELECT * FROM proposals WHERE proposal_id = ?').get(req.params.id);
  if (!pr) return res.status(404).json({ error: 'Proposal not found.' });
  const p = db.prepare('SELECT * FROM projects WHERE project_id = ? AND client_id = ?').get(pr.project_id, req.user.id);
  if (!p || p.status !== 'open') return res.status(400).json({ error: 'Cannot accept this proposal.' });
  db.prepare("UPDATE proposals SET status = 'accepted' WHERE proposal_id = ?").run(pr.proposal_id);
  db.prepare("UPDATE projects SET status = 'in_progress', freelancer_id = ? WHERE project_id = ?").run(pr.freelancer_id, p.project_id);
  res.json({ message: 'Freelancer selected.' });
});

// ---------- Milestones and escrow ----------
app.post('/api/projects/:id/milestones', auth('client'), (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE project_id = ? AND client_id = ?').get(req.params.id, req.user.id);
  if (!p || p.status !== 'in_progress') return res.status(400).json({ error: 'Select a freelancer first.' });
  const { title, criteria, amount } = req.body;
  if (!title || !amount) return res.status(400).json({ error: 'Title and amount are required.' });
  const r = db.prepare('INSERT INTO milestones (project_id, title, criteria, amount) VALUES (?,?,?,?)')
    .run(p.project_id, title, criteria, amount);
  db.prepare('INSERT INTO escrow (milestone_id, amount) VALUES (?,?)').run(r.lastInsertRowid, amount);
  res.json({ message: 'Milestone created. Payment is held in escrow.' });
});

app.post('/api/milestones/:id/submit', auth('freelancer'), (req, res) => {
  const m = db.prepare('SELECT m.*, p.freelancer_id FROM milestones m JOIN projects p ON p.project_id = m.project_id WHERE m.milestone_id = ?').get(req.params.id);
  if (!m || m.freelancer_id !== req.user.id) return res.status(403).json({ error: 'Not allowed.' });
  if (m.status !== 'funded' && m.status !== 'revision') return res.status(400).json({ error: 'Already submitted.' });
  const ai = aiVerify(m.criteria, req.body.work);
  db.prepare("UPDATE milestones SET status = 'submitted', submission = ?, ai_score = ?, ai_result = ? WHERE milestone_id = ?")
    .run(req.body.work, ai.score, ai.result, m.milestone_id);
  res.json({ message: 'Work submitted. AI check: ' + ai.result + ' (' + ai.score + '%).' });
});

app.post('/api/milestones/:id/review', auth('client'), (req, res) => {
  const m = db.prepare('SELECT m.*, p.client_id, p.freelancer_id FROM milestones m JOIN projects p ON p.project_id = m.project_id WHERE m.milestone_id = ?').get(req.params.id);
  if (!m || m.client_id !== req.user.id || m.status !== 'submitted') {
    return res.status(400).json({ error: 'Nothing to review.' });
  }
  let message;
  if (req.body.decision === 'approve') {
    db.prepare("UPDATE milestones SET status = 'approved' WHERE milestone_id = ?").run(m.milestone_id);
    db.prepare("UPDATE escrow SET status = 'released' WHERE milestone_id = ?").run(m.milestone_id);
    message = 'Approved. Payment released from escrow.';
  } else {
    db.prepare("UPDATE milestones SET status = 'revision', revisions = revisions + 1 WHERE milestone_id = ?").run(m.milestone_id);
    message = 'Revision requested.';
  }
  updateTrust(m.freelancer_id);
  updateTrust(m.client_id);
  res.json({ message });
});
// ---------- Admin ----------
app.get('/api/admin/summary', auth('admin'), (req, res) => {
  const count = t => db.prepare('SELECT COUNT(*) AS c FROM ' + t).get().c;
  const held = db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM escrow WHERE status = 'held'").get().s;
  const released = db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM escrow WHERE status = 'released'").get().s;
  res.json({
    users: count('users'),
    projects: count('projects'),
    proposals: count('proposals'),
    milestones: count('milestones'),
    held, released
  });
});

app.get('/api/admin/users', auth('admin'), (req, res) => {
  const rows = db.prepare(
    'SELECT u.user_id, u.name, u.email, u.role, COALESCE(t.score, 50) AS trust FROM users u LEFT JOIN trust_scores t ON t.user_id = u.user_id ORDER BY u.user_id'
  ).all();
  res.json(rows);
});

app.get('/api/admin/projects', auth('admin'), (req, res) => {
  const rows = db.prepare(
    'SELECT p.project_id, p.title, p.budget, p.status, c.name AS client, f.name AS freelancer FROM projects p JOIN users c ON c.user_id = p.client_id LEFT JOIN users f ON f.user_id = p.freelancer_id ORDER BY p.project_id DESC'
  ).all();
  res.json(rows);
});
app.listen(3000, () => console.log('Server running at http://localhost:3000'));