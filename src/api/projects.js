// REST API routes for work projects and their tasks
const express = require('express');
const pool    = require('../db/client');

const projects = express.Router();
const tasks    = express.Router();

const STATUSES   = ['planning', 'active', 'on_hold', 'done', 'cancelled'];
const PRIORITIES = ['low', 'medium', 'high'];
const PROJECT_FIELDS = ['name', 'prospect_id', 'status', 'priority', 'value', 'start_date', 'due_date', 'description'];

const LIST_SQL = `
  SELECT pr.*, p.company AS client_company, p.industry AS client_industry,
         COUNT(t.id)::int                                   AS task_total,
         COUNT(t.id) FILTER (WHERE t.done)::int             AS task_done,
         COUNT(t.id) FILTER (WHERE NOT t.done AND t.due_date < CURRENT_DATE)::int AS task_overdue,
         MIN(t.due_date) FILTER (WHERE NOT t.done)          AS next_task_due
    FROM projects pr
    LEFT JOIN prospects p ON p.id = pr.prospect_id
    LEFT JOIN tasks t     ON t.project_id = pr.id`;

function clean(body) {
  const out = {};
  for (const k of PROJECT_FIELDS) {
    if (body[k] === undefined) continue;
    out[k] = body[k] === '' ? null : body[k];
  }
  if (out.status && !STATUSES.includes(out.status)) throw Object.assign(new Error(`status must be one of ${STATUSES.join(', ')}`), { status: 400 });
  if (out.priority && !PRIORITIES.includes(out.priority)) throw Object.assign(new Error(`priority must be one of ${PRIORITIES.join(', ')}`), { status: 400 });
  return out;
}
const fail = (res, err) => res.status(err.status || 500).json({ error: err.message });

async function getProject(id) {
  const [p, t] = await Promise.all([
    pool.query(`${LIST_SQL} WHERE pr.id = $1 GROUP BY pr.id, p.company, p.industry`, [id]),
    pool.query(`SELECT * FROM tasks WHERE project_id = $1 ORDER BY done, sort_order, due_date NULLS LAST, id`, [id]),
  ]);
  return p.rows.length ? { ...p.rows[0], tasks: t.rows } : null;
}

// GET /api/projects?status=active,planning&prospect_id=
projects.get('/', async (req, res) => {
  try {
    const where = []; const params = [];
    if (req.query.status) { params.push(req.query.status.split(',')); where.push(`pr.status = ANY($${params.length})`); }
    if (req.query.prospect_id) { params.push(req.query.prospect_id); where.push(`pr.prospect_id = $${params.length}`); }
    const { rows } = await pool.query(
      `${LIST_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       GROUP BY pr.id, p.company, p.industry
       ORDER BY CASE pr.status WHEN 'active' THEN 0 WHEN 'planning' THEN 1 WHEN 'on_hold' THEN 2 ELSE 3 END,
                CASE pr.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                pr.due_date NULLS LAST, pr.id DESC`, params);
    res.json({ projects: rows, statuses: STATUSES });
  } catch (err) { fail(res, err); }
});

projects.get('/:id', async (req, res) => {
  try {
    const p = await getProject(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.json(p);
  } catch (err) { fail(res, err); }
});

projects.post('/', async (req, res) => {
  try {
    const f = clean(req.body || {});
    if (!f.name) return res.status(400).json({ error: 'name is required' });
    const keys = Object.keys(f);
    const { rows } = await pool.query(
      `INSERT INTO projects (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`,
      keys.map(k => f[k]));
    res.status(201).json(await getProject(rows[0].id));
  } catch (err) { fail(res, err); }
});

projects.patch('/:id', async (req, res) => {
  try {
    const f = clean(req.body || {});
    const keys = Object.keys(f);
    if (!keys.length) return res.status(400).json({ error: 'No valid fields' });
    const r = await pool.query(
      `UPDATE projects SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
      [req.params.id, ...keys.map(k => f[k])]);
    if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
    res.json(await getProject(req.params.id));
  } catch (err) { fail(res, err); }
});

projects.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM projects WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

// POST /api/projects/:id/tasks
projects.post('/:id/tasks', async (req, res) => {
  const title = (req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title is required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO tasks (project_id, title, due_date, sort_order)
       VALUES ($1, $2, $3, COALESCE((SELECT MAX(sort_order) + 1 FROM tasks WHERE project_id = $1), 0)) RETURNING *`,
      [req.params.id, title, req.body.due_date || null]);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23503') return res.status(404).json({ error: 'Project not found' });
    fail(res, err);
  }
});

// PATCH /api/tasks/:id  { title?, done?, due_date?, sort_order? }
tasks.patch('/:id', async (req, res) => {
  const f = {};
  for (const k of ['title', 'done', 'due_date', 'sort_order']) if (req.body?.[k] !== undefined) f[k] = req.body[k] === '' ? null : req.body[k];
  const keys = Object.keys(f);
  if (!keys.length) return res.status(400).json({ error: 'No valid fields' });
  try {
    const extra = f.done === undefined ? '' : `, completed_at = CASE WHEN $${keys.length + 2}::boolean THEN NOW() ELSE NULL END`;
    const params = [req.params.id, ...keys.map(k => f[k])];
    if (extra) params.push(!!f.done);
    const { rows } = await pool.query(
      `UPDATE tasks SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}${extra} WHERE id = $1 RETURNING *`, params);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { fail(res, err); }
});

tasks.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

module.exports = { projects, tasks };
