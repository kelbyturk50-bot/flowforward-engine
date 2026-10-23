// Strings the public chat API returns. Kept here so the lazy chat chunk
// owns them. The entry bundle must not import this file.

export const PAUSE_MESSAGE = "Demo paused. The live AI is resting for today; you're seeing sample replies.";
// Composer is locked. Do not promise sample replies.
export const PAUSE_LOCKED_MESSAGE = 'Demo paused. Chat is off today. Ask FlowForward to turn it back on.';
export const LIMIT_MESSAGE = 'Demo limit reached';
export const LIMIT_NOTICE = 'Demo limit reached. No more messages today. Ask FlowForward for another look tomorrow.';
export const EXPIRED_TITLE = 'This demo link has expired';
// src/prototypes/store.js sets expires_at to issued_at + 336 hours, which is 14 days.
export const LINK_LIFETIME = 'Demo links last 14 days.';
export const LINK_NEXT_STEP = 'Ask FlowForward for a fresh link.';
export const LOAD_ERROR = "This sample reply didn't load.";
export const TOO_LONG_ERROR = 'That message is too long for this demo. Shorten it and send again.';
export const INVALID_ERROR = 'That message could not be sent. Edit it and try again.';
