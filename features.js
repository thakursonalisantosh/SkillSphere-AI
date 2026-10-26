module.exports = function (app, db, auth, getTrust, updateTrust) {
  const addCol = (t, c, d) => { try { db.exec('ALTER TABLE ' + t + ' ADD COLUMN ' + c + ' ' + d); } catch (e) {} };
  addCol('users', 'skills', 'TEXT');
  addCol('projects', 'required_skills', 'TEXT');

  db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    message_id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    message TEXT NOT NULL,
    scope_flag INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS disputes (
    dispute_id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    milestone_id INTEGER,
    raised_by INTEGER NOT NULL,
    reason TEXT NOT NULL,
    ai_summary TEXT,
    ai_suggestion TEXT,
    status TEXT DEFAULT 'open',
    resolution TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    log_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT,
    details TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );`);

  const parseSkills = s => (s || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);

  // ---------- Audit log: records every successful POST action ----------
  app.use((req, res, next) => {
    res.on('finish', () => {
      try {
        if (req.method === 'POST' && req.path.startsWith('/api/') && res.statusCode < 400) {
          const who = req.user ? req.user.id : null;
          const info = (req.path === '/api/login' || req.path === '/api/register') && req.body ? req.body.email : null;
          db.prepare('INSERT INTO audit_logs (user_id, action, details) VALUES (?,?,?)').run(who, req.path, info);
        }
      } catch (e) {}
    });
    next();
  });

  // ---------- Skills and blind matching ----------
  app.get('/api/profile', auth(), (req, res) => {
    res.json(db.prepare('SELECT name, role, skills FROM users WHERE user_id = ?').get(req.user.id));
  });

  app.post('/api/profile/skills', auth('freelancer'), (req, res) => {
    db.prepare('UPDATE users SET skills = ? WHERE user_id = ?')
      .run(parseSkills(req.body.skills).join(', '), req.user.id);
    res.json({ message: 'Skills saved.' });
  });

  app.post('/api/projects', auth('client'), (req, res) => {
    const { title, description, budget, deadline, required_skills } = req.body;
    if (!title || !budget) return res.status(400).json({ error: 'Title and budget are required.' });
    db.prepare('INSERT INTO projects (client_id, title, description, budget, deadline, required_skills) VALUES (?,?,?,?,?,?)')
      .run(req.user.id, title, description, budget, deadline, parseSkills(required_skills).join(', '));
    res.json({ message: 'Project posted.' });
  });

  app.get('/api/projects/:id/proposals', auth('client'), (req, res) => {
    const p = db.prepare('SELECT required_skills FROM projects WHERE project_id = ? AND client_id = ?')
      .get(req.params.id, req.user.id);
    if (!p) return res.status(403).json({ error: 'Not allowed.' });
    const need = parseSkills(p.required_skills);
    const rows = db.prepare(
      'SELECT pr.proposal_id, pr.freelancer_id, pr.bid_amount, pr.cover_letter, pr.status, u.skills FROM proposals pr JOIN users u ON u.user_id = pr.freelancer_id WHERE pr.project_id = ?'
    ).all(req.params.id);
    const out = rows.map(r => {
      const have = parseSkills(r.skills);
      const match = need.length ? Math.round(need.filter(s => have.includes(s)).length / need.length * 100) : 0;
      const trust = getTrust(r.freelancer_id);
      return {
        proposal_id: r.proposal_id, freelancer_id: r.freelancer_id, bid_amount: r.bid_amount,
        cover_letter: r.cover_letter, status: r.status, skills: have.join(', '),
        match, trust, rank: Math.round(match * 0.6 + trust * 0.4)
      };
    });
    out.sort((a, b) => b.rank - a.rank);
    res.json(out);
  });

  // ---------- Chat with scope creep guardian ----------
  const SCOPE_WORDS = ['also add', 'one more', 'extra', 'additionally', 'in addition', 'new feature',
    'another page', 'can you also', 'change the design', 'add one'];

  function canAccess(req, projectId) {
    const p = db.prepare('SELECT client_id, freelancer_id FROM projects WHERE project_id = ?').get(projectId);
    return p && (p.client_id === req.user.id || p.freelancer_id === req.user.id);
  }

  app.get('/api/projects/:id/messages', auth(), (req, res) => {
    if (!canAccess(req, req.params.id)) return res.status(403).json({ error: 'Not allowed.' });
    res.json(db.prepare(
      'SELECT m.message_id, m.sender_id, u.name, m.message, m.scope_flag, m.created_at FROM messages m JOIN users u ON u.user_id = m.sender_id WHERE m.project_id = ? ORDER BY m.message_id'
    ).all(req.params.id));
  });

  app.post('/api/projects/:id/messages', auth(), (req, res) => {
    if (!canAccess(req, req.params.id)) return res.status(403).json({ error: 'Not allowed.' });
    const text = (req.body.message || '').trim();
    if (!text) return res.status(400).json({ error: 'Message is empty.' });
    const flag = SCOPE_WORDS.some(w => text.toLowerCase().includes(w)) ? 1 : 0;
    db.prepare('INSERT INTO messages (project_id, sender_id, message, scope_flag) VALUES (?,?,?,?)')
      .run(req.params.id, req.user.id, text, flag);
    res.json({ 
  message: 'Sent.',
  scopeFlag: flag === 1
});
  });

  // ---------- Disputes with AI mediation ----------
  function mediate(project, miles, msgs) {
    const count = s => miles.filter(m => m.status === s).length;
    const revs = miles.reduce((s, m) => s + (m.revisions || 0), 0);
    const flagged = msgs.filter(m => m.scope_flag).length;
    const target = miles.find(m => m.status === 'submitted' || m.status === 'revision') || miles[miles.length - 1] || null;

    const summary = 'Project "' + project.title + '" has ' + miles.length + ' milestone(s): ' +
      count('approved') + ' approved, ' + count('submitted') + ' waiting for review, ' + count('revision') + ' in revision. ' +
      'Revision requests so far: ' + revs + '. Chat has ' + msgs.length + ' message(s), ' +
      flagged + ' of them look like extra work requests.';

    let suggestion;
    if (!target) {
      suggestion = 'No milestone exists yet, so there is no payment to decide. Both sides should agree on milestones first.';
    } else if (target.ai_score != null && target.ai_score >= 60 && revs <= 1) {
      suggestion = 'The AI check found that the submitted work meets the criteria (' + target.ai_score +
        '%). Suggested resolution: release the payment for "' + target.title + '".';
    } else if (flagged >= 2) {
      suggestion = 'The client asked for extra work outside the original scope. Suggested resolution: create a new milestone with extra payment for the added work.';
    } else if (target.ai_score != null && target.ai_score < 60) {
      suggestion = 'The AI check found that the work does not meet the criteria (' + target.ai_score +
        '%). Suggested resolution: ask the freelancer to revise "' + target.title + '" before payment.';
    } else {
      suggestion = 'The evidence is not clear. Suggested resolution: admin reviews the work and considers a partial release.';
    }
    return { summary, suggestion, milestone_id: target ? target.milestone_id : null };
  }

  app.post('/api/projects/:id/dispute', auth(), (req, res) => {
    if (!canAccess(req, req.params.id)) return res.status(403).json({ error: 'Not allowed.' });
    const reason = (req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Please write the reason.' });
    const open = db.prepare("SELECT 1 FROM disputes WHERE project_id = ? AND status = 'open'").get(req.params.id);
    if (open) return res.status(400).json({ error: 'A dispute is already open for this project.' });

    const project = db.prepare('SELECT * FROM projects WHERE project_id = ?').get(req.params.id);
    const miles = db.prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY milestone_id').all(req.params.id);
    const msgs = db.prepare('SELECT message, scope_flag FROM messages WHERE project_id = ?').all(req.params.id);
    const ai = mediate(project, miles, msgs);

    db.prepare('INSERT INTO disputes (project_id, milestone_id, raised_by, reason, ai_summary, ai_suggestion) VALUES (?,?,?,?,?,?)')
      .run(req.params.id, ai.milestone_id, req.user.id, reason, ai.summary, ai.suggestion);
    res.json({ message: 'Dispute raised. AI summary sent to the admin.' });
  });

  app.get('/api/projects/:id/disputes', auth(), (req, res) => {
    if (!canAccess(req, req.params.id)) return res.status(403).json({ error: 'Not allowed.' });
    res.json(db.prepare('SELECT dispute_id, reason, status, resolution, created_at FROM disputes WHERE project_id = ? ORDER BY dispute_id DESC').all(req.params.id));
  });

  // ---------- Admin ----------
  app.get('/api/admin/disputes', auth('admin'), (req, res) => {
    res.json(db.prepare(
      'SELECT d.*, p.title, u.name AS raised_by_name FROM disputes d JOIN projects p ON p.project_id = d.project_id JOIN users u ON u.user_id = d.raised_by ORDER BY d.dispute_id DESC'
    ).all());
  });

  app.post('/api/admin/disputes/:id/resolve', auth('admin'), (req, res) => {
    const d = db.prepare('SELECT * FROM disputes WHERE dispute_id = ?').get(req.params.id);
    if (!d || d.status !== 'open') return res.status(400).json({ error: 'This dispute is not open.' });
    const { action, note } = req.body;
    if (d.milestone_id) {
      if (action === 'release') {
        db.prepare("UPDATE milestones SET status = 'approved' WHERE milestone_id = ?").run(d.milestone_id);
        db.prepare("UPDATE escrow SET status = 'released' WHERE milestone_id = ?").run(d.milestone_id);
      } else if (action === 'revision') {
        db.prepare("UPDATE milestones SET status = 'revision' WHERE milestone_id = ?").run(d.milestone_id);
      }
    }
    db.prepare("UPDATE disputes SET status = 'resolved', resolution = ? WHERE dispute_id = ?")
      .run((action || 'noted') + ': ' + (note || ''), d.dispute_id);
    const p = db.prepare('SELECT client_id, freelancer_id FROM projects WHERE project_id = ?').get(d.project_id);
    if (p) {
      updateTrust(p.client_id);
      if (p.freelancer_id) updateTrust(p.freelancer_id);
    }
    res.json({ message: 'Dispute resolved.' });
  });

  app.get('/api/admin/audit', auth('admin'), (req, res) => {
    res.json(db.prepare(
      "SELECT a.log_id, COALESCE(u.name, a.details, '-') AS who, a.action, a.created_at FROM audit_logs a LEFT JOIN users u ON u.user_id = a.user_id ORDER BY a.log_id DESC LIMIT 30"
    ).all());
  });

  app.get('/api/admin/charts', auth('admin'), (req, res) => {
    const group = (t, c) => db.prepare('SELECT ' + c + ' AS k, COUNT(*) AS n FROM ' + t + ' GROUP BY ' + c).all();
    res.json({ roles: group('users', 'role'), projects: group('projects', 'status'), milestones: group('milestones', 'status') });
  });
};