// Disposable Postgres for npm test.
// Prefers a temporary cluster (initdb/pg_ctl) so nothing is shared with dev or
// production. Falls back to docker-compose.test.yml when those binaries are absent.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const COMPOSE_FILE = path.join(__dirname, '..', 'docker-compose.test.yml');
const COMPOSE_PROJECT = 'flowforward-engine-test';
const DOCKER_PORT = 54329;
const DB_USER = 'fftest';
const DB_NAME = 'flowforward_test';

function exec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(cmd)} ${args.join(' ')} exited ${code}\n${out}`));
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function findPgBin() {
  const versions = fs.existsSync('/usr/lib/postgresql')
    ? fs.readdirSync('/usr/lib/postgresql').sort().reverse()
    : [];
  const dirs = [
    ...versions.map(v => path.join('/usr/lib/postgresql', v, 'bin')),
    ...(process.env.PATH || '').split(path.delimiter),
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    if (fs.existsSync(path.join(dir, 'initdb')) && fs.existsSync(path.join(dir, 'pg_ctl'))) return dir;
  }
  return null;
}

function dockerComposeAvailable() {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function startCluster() {
  const bin = findPgBin();
  if (!bin) return null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowforward-pg-'));
  const dataDir = path.join(root, 'data');
  const logFile = path.join(root, 'postgres.log');
  const port = await freePort();
  const initdb = path.join(bin, 'initdb');
  const pgCtl = path.join(bin, 'pg_ctl');
  const createdb = path.join(bin, 'createdb');

  await exec(initdb, ['-D', dataDir, '-U', DB_USER, '--auth=trust', '--encoding=UTF8', '--locale=C', '--no-instructions']);
  try {
    await exec(pgCtl, ['-D', dataDir, '-l', logFile, '-w', '-o', `-p ${port} -h 127.0.0.1 -k ${root}`, 'start']);
  } catch (err) {
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    throw new Error(`${err.message}\n${log}`);
  }
  await exec(createdb, ['-h', '127.0.0.1', '-p', String(port), '-U', DB_USER, DB_NAME]);

  const url = `postgresql://${DB_USER}@127.0.0.1:${port}/${DB_NAME}`;
  return {
    url,
    port,
    kind: 'cluster',
    async stop() {
      await exec(pgCtl, ['-D', dataDir, '-w', '-m', 'fast', 'stop']).catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function startDocker() {
  if (!dockerComposeAvailable() || !fs.existsSync(COMPOSE_FILE)) return null;
  await exec('docker', ['compose', '-f', COMPOSE_FILE, '-p', COMPOSE_PROJECT, 'up', '-d', '--wait']);
  const url = `postgresql://${DB_USER}:fftest@127.0.0.1:${DOCKER_PORT}/${DB_NAME}`;
  return {
    url,
    port: DOCKER_PORT,
    kind: 'docker',
    async stop() {
      await exec('docker', ['compose', '-f', COMPOSE_FILE, '-p', COMPOSE_PROJECT, 'down', '-v']).catch(() => {});
    },
  };
}

async function startDisposablePostgres() {
  const cluster = await startCluster();
  if (cluster) return cluster;
  const docker = await startDocker();
  if (docker) return docker;
  throw new Error(
    'Could not start a disposable Postgres. Install PostgreSQL (initdb and pg_ctl) or Docker, then re-run npm test. '
    + 'Refusing to use any non-local DATABASE_URL.'
  );
}

module.exports = { startDisposablePostgres, findPgBin };
