// Loads the prototype rubric seeded by src/db/schema.sql.
// The lookup uses these rows. It does not fetch.

const { RUBRIC } = require('./prototypes.config');

function rubricFromParts(meta, pointRows) {
  const agents = {};
  const gapSignals = [];
  const rows = [];
  for (const row of pointRows) {
    const agent = row.agent;
    const tieRank = Number(row.tie_rank);
    if (!agents[agent]) agents[agent] = { tieRank, points: {} };
    if (agents[agent].tieRank !== tieRank) {
      throw new Error(`rubric tie_rank mismatch for ${agent}`);
    }
    const points = Number(row.points);
    agents[agent].points[row.signal] = points;
    const gap = row.is_gap === true;
    if (gap && !gapSignals.includes(row.signal)) gapSignals.push(row.signal);
    rows.push({
      version: Number(row.version),
      agent,
      signal: row.signal,
      points,
      tieRank,
      gap,
    });
  }
  return {
    version: Number(meta.version),
    spec: meta.spec_ref || RUBRIC.spec,
    minScore: Number(meta.min_score),
    maxPicks: Number(meta.max_picks),
    neverAutoPick: meta.never_auto_pick,
    serviceTitanAllow: meta.st_allow,
    gapSignals,
    agents,
    rows,
  };
}

async function loadRubric(pool) {
  const metaResult = await pool.query(
    `SELECT version, min_score, max_picks, never_auto_pick, st_allow, spec_ref
       FROM prototype_rubric_meta
      ORDER BY version DESC
      LIMIT 1`
  );
  const meta = metaResult.rows[0];
  if (!meta) throw new Error('prototype rubric is not seeded');
  const points = await pool.query(
    `SELECT version, agent, signal, points, tie_rank, is_gap
       FROM prototype_rubric
      WHERE version = $1
      ORDER BY tie_rank, agent, signal`,
    [meta.version]
  );
  if (!points.rows.length) throw new Error('prototype rubric has no rows');
  return rubricFromParts(meta, points.rows);
}

module.exports = { loadRubric, rubricFromParts };
