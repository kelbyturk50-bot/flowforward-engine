// Live model responder. Every Anthropic call goes through draft.getClient.
// Tests swap the client with draft._setClient. This module does not construct one.

const { getClient } = require('../proposals/draft');
const cfg = require('../proposals/config');
const { CHAT_CAPS } = require('./caps');
const { usdToMicros } = require('./ceiling');

const TIMEOUT_MS = 15000;

function parseResponse(res) {
  const blocks = Array.isArray(res && res.content) ? res.content : [];
  const text = blocks.filter((block) => block && block.type === 'text').map((block) => block.text || '').join('\n').trim();
  const tools = blocks.filter((block) => block && block.type === 'tool_use').map((block) => ({
    name: block.name,
    args: block.input && typeof block.input === 'object' && !Array.isArray(block.input) ? block.input : {},
  }));
  const usage = res && res.usage ? res.usage : {};
  const shaped = {
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
    cacheWrite: usage.cache_creation_input_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
  };
  return {
    text,
    tools,
    usage: shaped,
    costMicros: usdToMicros(cfg.costOf(cfg.MODEL, shaped)),
  };
}

async function liveRespond({ prompt }) {
  let client;
  try {
    client = getClient();
  } catch (err) {
    const wrapped = new Error('not_sent');
    wrapped.code = 'not_sent';
    throw wrapped;
  }
  if (!client || !client.messages || typeof client.messages.create !== 'function') {
    const err = new Error('not_sent');
    err.code = 'not_sent';
    throw err;
  }
  let pending;
  try {
    pending = client.messages.create({
      model: cfg.MODEL,
      max_tokens: CHAT_CAPS.maxOutputTokens,
      system: prompt.system,
      tools: prompt.tools,
      messages: prompt.messages,
    });
  } catch (err) {
    const wrapped = new Error('not_sent');
    wrapped.code = 'not_sent';
    throw wrapped;
  }
  let timer;
  const tracked = Promise.resolve(pending).then((value) => {
    clearTimeout(timer);
    return value;
  }, (err) => {
    clearTimeout(timer);
    throw err;
  });
  try {
    const res = await Promise.race([
      tracked,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error('timeout');
          err.code = 'responder_timeout';
          reject(err);
        }, TIMEOUT_MS);
      }),
    ]);
    return parseResponse(res);
  } catch (err) {
    clearTimeout(timer);
    if (err && err.code === 'responder_timeout') throw err;
    if (pending && typeof pending.then === 'function') {
      const late = new Error('timeout');
      late.code = 'responder_timeout';
      throw late;
    }
    const wrapped = new Error('not_sent');
    wrapped.code = 'not_sent';
    throw wrapped;
  }
}

module.exports = { liveRespond, TIMEOUT_MS, parseResponse };
