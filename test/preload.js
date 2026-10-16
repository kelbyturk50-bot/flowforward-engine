// Loaded before every test file. Refuses a non-local DATABASE_URL and arms
// the network guard before application code (and dotenv) can run.
//
// Children started with spawn/exec inherit NODE_OPTIONS. A Worker with
// execArgv: [] and a child that scrubs its environment do not, and are out of scope.

const path = require('path');
const { assertSafeDatabaseEnv, blankLiveCredentials, installNetworkGuard } = require('./guard');

const preloadPath = path.resolve(__dirname, 'preload.js');
const requireFlag = `--require ${preloadPath}`;
const nodeOptions = process.env.NODE_OPTIONS || '';
if (!nodeOptions.includes(preloadPath)) {
  process.env.NODE_OPTIONS = nodeOptions ? `${nodeOptions} ${requireFlag}` : requireFlag;
}

blankLiveCredentials();
process.env.NODE_ENV = 'test';
process.env.DISABLE_CRON = '1';
if (!process.env.PUBLIC_BASE_URL || !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(process.env.PUBLIC_BASE_URL)) {
  process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:3000';
}
if (!process.env.SENDER_ADDRESS) {
  process.env.SENDER_ADDRESS = '1 Test Street, Saratoga Springs, UT 84045';
}

assertSafeDatabaseEnv();
installNetworkGuard();
