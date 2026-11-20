import { formatDenverDateTime } from '../live-chat/dates.js';

// Server copy from approveAndSend when a held-back draft is sent without
// confirm: true. It is a different acknowledgement from the recent-reply warning.
export const HELD_BACK_MESSAGE = 'Confirm this send before it goes out again.';

export function recentReplySentence(repliedAt) {
  const when = formatDenverDateTime(repliedAt);
  if (!when) return '';
  return `This lead replied to another proposal on ${when}. Check that reply before sending again.`;
}

// 409 { error: "recent_reply", sibling_proposal_id, replied_at }.
// A string id or a string "true" acknowledgement does not count.
export function recentReplyDetails(error) {
  if (!error || error.status !== 409) return null;
  if (error.message !== 'recent_reply' && error.code !== 'recent_reply') return null;
  const id = error.sibling_proposal_id;
  const repliedAt = error.replied_at;
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) return null;
  const sentence = recentReplySentence(repliedAt);
  if (!sentence) return null;
  return { sibling_proposal_id: id, replied_at: repliedAt, sentence };
}

export function isHeldBackConfirm(error) {
  return Boolean(error) && error.status === 409 && error.message === HELD_BACK_MESSAGE;
}

// Only a JSON boolean true is sent. An empty body stays undefined so a normal
// approve matches the request main sends (no JSON body).
export function approveSendBody({ confirm = false, acknowledge = false } = {}) {
  const body = {};
  if (confirm === true) body.confirm = true;
  if (acknowledge === true) body.acknowledge_recent_reply = true;
  return Object.keys(body).length ? body : undefined;
}
