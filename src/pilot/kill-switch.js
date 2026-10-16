// Global live-send kill for Pilot #1. This file does not send mail.
// Sends stay killed unless FF_PILOT_ESTIMATE_LIVE_SEND is exactly "true".
// pilot_customers.live_send_enabled must also be true. Nothing in the CSV
// intake sets that column to true. Only an operator can change either gate.

const KILL_ENV = 'FF_PILOT_ESTIMATE_LIVE_SEND';

function globalSendKilled() {
  return process.env[KILL_ENV] !== 'true';
}

function customerSendAllowed(liveSendEnabled) {
  return globalSendKilled() === false && liveSendEnabled === true;
}

module.exports = {
  KILL_ENV,
  globalSendKilled,
  customerSendAllowed,
};
