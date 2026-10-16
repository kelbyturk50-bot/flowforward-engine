// Synthetic unsold-estimate recovery payload.
// Matches the shape web/src/demo/fixture.js buildDemo() returns, so the CRM
// view can later fetch this route without changing its fields.
// Company name comes from the caller (the prospect on the proposal).
// Amounts, copy, and the financing reply are fixed sample data.
// Nothing here is a customer, an address, a phone number, or an email address.

const DEFAULT_COMPANY = 'Example Heating & Air';

const OPEN_TOTAL = 38400;
const RECOVERED = 14800;

const OPEN_ESTIMATES = Object.freeze([
  Object.freeze({
    id: 'furnace',
    name: 'Furnace replacement',
    amount: 14800,
    options: Object.freeze([
      Object.freeze({ tier: 'Good', amount: 9800 }),
      Object.freeze({ tier: 'Better', amount: 14800 }),
      Object.freeze({ tier: 'Best', amount: 19600 }),
    ]),
  }),
  Object.freeze({ id: 'ac', name: 'AC replacement', amount: 16400 }),
  Object.freeze({ id: 'duct', name: 'Duct job', amount: 7200 }),
]);

function cleanCompany(value) {
  const cleaned = Array.from(String(value ?? '')).filter((ch) => {
    const code = ch.codePointAt(0);
    return code > 0x1f && code !== 0x7f;
  }).join('').trim().slice(0, 80);
  return cleaned || DEFAULT_COMPANY;
}

function timelineFor(company) {
  return [
    {
      id: 'instant',
      when: 'Instant',
      kind: 'email',
      title: 'Thank you',
      subject: `Thanks from ${company}`,
      body: `${company} would thank the homeowner and include the estimate they asked about. This card is a preview of that note.`,
    },
    {
      id: 'day2',
      when: 'Day 2',
      kind: 'email',
      title: 'Answers to common questions',
      subject: 'Answers to common questions',
      body: `${company} would cover timing, what the price includes, and how Good, Better, and Best differ on the furnace replacement.`,
    },
    {
      id: 'day5',
      when: 'Day 5',
      kind: 'task',
      title: 'Call now (opened 3×)',
      subject: 'Call now (opened 3×)',
      body: `Owner task for ${company}. The sample estimate was opened 3 times. This reminder stays on the owner side of the demo. No call is placed.`,
    },
    {
      id: 'day10',
      when: 'Day 10',
      kind: 'email',
      title: 'Close the loop',
      subject: 'Closing the loop',
      body: `${company} would send one last note that the estimate is still open. This preview does not send it.`,
    },
  ];
}

function replyFor(company) {
  return {
    question: 'Is there financing?',
    draft: `Yes. ${company} can walk through financing next to the Better furnace option at $14,800. This reply stays a draft until the owner approves it. Approval here does not send it.`,
  };
}

function buildDemo({ company } = {}) {
  const name = cleanCompany(company);
  const estimates = OPEN_ESTIMATES.map(item => ({
    id: item.id,
    name: item.name,
    amount: item.amount,
    options: item.options ? item.options.map(option => ({ tier: option.tier, amount: option.amount })) : undefined,
  }));
  const sum = estimates.reduce((total, item) => total + item.amount, 0);
  if (sum !== OPEN_TOTAL) throw new Error('Sample estimates must total 38400');
  return {
    company: name,
    synthetic: true,
    openCount: estimates.length,
    openTotal: OPEN_TOTAL,
    recovered: RECOVERED,
    estimates,
    timeline: timelineFor(name),
    reply: replyFor(name),
  };
}

module.exports = { DEFAULT_COMPANY, OPEN_TOTAL, RECOVERED, OPEN_ESTIMATES, buildDemo, cleanCompany };
