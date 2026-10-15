// Background queue for single-lead drafts and rewrites. Each request becomes a
// row in proposal_jobs and runs here one at a time, so the CRM can close the
// page and come back. Jobs left "running" by a restart are marked failed on boot.

const pool = require('../db/client');
const { draftProposal } = require('./draft');

let working = false;

async function enqueue({ prospectId, kind, sourceProposalId = null, instructions = null, freshResearch = false }) {
  // One active job per lead: return the existing one instead of stacking up.
  const active = await pool.query(
    `SELECT * FROM proposal_jobs WHERE prospect_id = $1 AND status IN ('queued', 'running') ORDER BY id DESC LIMIT 1`, [prospectId]);
  if (active.rows.length) return { job: active.rows[0], existing: true };
  const { rows } = await pool.query(
    `INSERT INTO proposal_jobs (prospect_id, kind, source_proposal_id, instructions, fresh_research)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [prospectId, kind, sourceProposalId, instructions || null, !!freshResearch]);
  setImmediate(() => work().catch(err => console.error('[jobs] worker error:', err.message)));
  return { job: rows[0], existing: false };
}

async function work() {
  if (working) return;
  working = true;
  try {
    for (;;) {
      const { rows } = await pool.query(
        `UPDATE proposal_jobs SET status = 'running', started_at = NOW()
          WHERE id = (SELECT id FROM proposal_jobs WHERE status = 'queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING *`);
      const job = rows[0];
      if (!job) break;
      try {
        const p = await draftProposal(job.prospect_id, {
          instructions: job.instructions, reuseResearch: !job.fresh_research, trigger: 'manual',
        });
        await pool.query(`UPDATE proposal_jobs SET status = 'done', result_proposal_id = $2, finished_at = NOW() WHERE id = $1`, [job.id, p.id]);
        console.log(`[jobs] #${job.id} ${job.kind} for prospect ${job.prospect_id} → proposal ${p.id}`);
      } catch (err) {
        await pool.query(`UPDATE proposal_jobs SET status = 'failed', error = $2, finished_at = NOW() WHERE id = $1`, [job.id, err.message]);
        console.error(`[jobs] #${job.id} failed: ${err.message}`);
      }
    }
  } finally {
    working = false;
  }
}

// On boot: anything "running" was cut off by a restart; anything queued gets picked up.
async function recover() {
  await pool.query(`UPDATE proposal_jobs SET status = 'failed', error = 'Interrupted by a server restart. Try again.', finished_at = NOW()
                     WHERE status = 'running'`);
  setImmediate(() => work().catch(err => console.error('[jobs] worker error:', err.message)));
}

const JOB_COLS = `j.*, p.company, rp.version AS result_version, sp.version AS source_version`;
const JOIN = `FROM proposal_jobs j JOIN prospects p ON p.id = j.prospect_id
              LEFT JOIN proposals rp ON rp.id = j.result_proposal_id LEFT JOIN proposals sp ON sp.id = j.source_proposal_id`;

/** Active jobs plus finished ones from the last 2 days that haven't been dismissed. */
async function list({ prospectId } = {}) {
  const params = []; let extra = '';
  if (prospectId) { params.push(prospectId); extra = `AND j.prospect_id = $1`; }
  const { rows } = await pool.query(
    `SELECT ${JOB_COLS} ${JOIN}
      WHERE (j.status IN ('queued', 'running') OR (j.dismissed_at IS NULL AND j.finished_at > NOW() - INTERVAL '2 days')) ${extra}
      ORDER BY j.id DESC LIMIT 50`, params);
  return rows;
}

async function dismiss(id) {
  await pool.query(`UPDATE proposal_jobs SET dismissed_at = NOW() WHERE id = $1 AND status IN ('done', 'failed')`, [id]);
}

module.exports = { enqueue, work, recover, list, dismiss, isWorking: () => working };
