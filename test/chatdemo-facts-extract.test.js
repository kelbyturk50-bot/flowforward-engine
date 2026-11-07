require('./preload');

// Facts read from cached research (src/chatdemo/facts-extract.js). Pure:
// no database, no fetch, no model. Every fact must be tied to a verbatim
// snippet from the page or Google record it came from.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractFacts, foldHours } = require('../src/chatdemo/facts-extract');

const HOME = 'https://alpinecomfort.example/';

function research(text, extra = {}) {
  return {
    business: { company: 'Alpine Comfort Heating', phone: '(801) 555-0199', address: '9 Main St, Lehi, UT' },
    site: { pages: [{ url: HOME, text }] },
    ...extra,
  };
}

function byField(facts) {
  return Object.fromEntries(facts.map((fact) => [fact.field, fact]));
}

describe('facts from cached research', () => {
  it('ties every fact to a verbatim snippet on its own page', () => {
    const text = 'Alpine Comfort Heating serves Lehi, Highland, Alpine and Saratoga Springs. AC Repair, Furnace Repair and Heat Pumps. Licensed & Insured. 24/7 emergency service. Financing available. Ask about our Comfort Club.';
    const facts = extractFacts(research(text), { company: 'Alpine Comfort Heating' });
    const f = byField(facts);
    for (const fact of facts) {
      assert.equal(fact.source, 'cached_research');
      assert.equal(fact.source_url, HOME, fact.field);
      assert.ok(text.includes(fact.snippet), `${fact.field} snippet is verbatim`);
      assert.ok([...fact.snippet].length <= 300);
    }
    assert.equal(f.services.value, 'AC Repair, Furnace Repair, Heat Pumps');
    assert.equal(f.service_area.value, 'Lehi, Highland, Alpine, Saratoga Springs', 'the town after the company name still counts');
    for (const field of ['emergency_247', 'financing', 'maintenance_plan', 'license', 'insurance']) {
      assert.equal(f[field].value, 'yes', field);
    }
    assert.equal(f.bonding, undefined);
    assert.equal(f.hours, undefined, 'no Google record, no hours');
  });

  it('never extracts prices, warranties, guarantees, years, or license numbers', () => {
    const text = 'Furnace tune-up $89. 10-year parts warranty. Satisfaction guaranteed. Serving Provo since 1998. License #12345678-5501.';
    const fields = extractFacts(research(text)).map((fact) => fact.field);
    for (const field of ['price', 'warranty', 'guarantee', 'years_in_business', 'license_number', 'license']) {
      assert.equal(fields.includes(field), false, field);
    }
  });

  it('skips negated claims, street names, and the company name', () => {
    const text = 'Alpine Heating does not offer financing. We do not provide 24/7 service. Visit 400 W Highland Drive or Murray Blvd.';
    const f = byField(extractFacts(research(text), { company: 'Alpine Heating' }));
    assert.equal(f.financing, undefined);
    assert.equal(f.emergency_247, undefined);
    assert.equal(f.service_area, undefined);
  });

  it('reads no reviews, no http pages, and no non-Google source as per Google', () => {
    const google = {
      maps_url: 'https://maps.google.com.evil.example/?cid=1',
      hours: ['Monday: 8:00 AM – 5:00 PM'],
      reviews: [{ rating: 5, text: 'Free estimates and 24/7 service, licensed and insured!' }],
    };
    const facts = extractFacts({
      business: { phone: '(801) 555-0199' },
      google,
      site: { pages: [{ url: 'http://plain.example/', text: 'Free estimates. AC Repair. Lehi.' }] },
    });
    assert.deepEqual(facts, [], 'lookalike Google host and http page give nothing');
  });

  it('uses Google hours, phone, and address only with a google.com maps link', () => {
    const facts = extractFacts(research('Call (801) 555-0199 today.', {
      google: {
        maps_url: 'https://maps.google.com/?cid=7',
        hours: ['Monday: 7:00 AM – 6:00 PM', 'Tuesday: 7:00 AM – 6:00 PM', 'Wednesday: Closed'],
      },
    }));
    const f = byField(facts);
    assert.equal(f.hours.value, 'Monday–Tuesday: 7:00 AM – 6:00 PM; Wednesday: Closed');
    assert.equal(f.hours.snippet, 'Monday: 7:00 AM – 6:00 PM; Tuesday: 7:00 AM – 6:00 PM; Wednesday: Closed');
    assert.equal(f.phone.source_url, 'https://maps.google.com/?cid=7');
    assert.equal(f.address.value, '9 Main St, Lehi, UT');
  });

  it('falls back to the phone the site prints when Google has none', () => {
    const f = byField(extractFacts(research('Questions? Call 801.555.0199 anytime.')));
    assert.equal(f.phone.value, '801.555.0199');
    assert.equal(f.phone.source_url, HOME);
    assert.equal(f.address, undefined);
  });

  it('folds matching days and leaves odd lines alone', () => {
    assert.equal(foldHours(['Monday: Closed', 'Tuesday: Closed']), 'Monday–Tuesday: Closed');
    assert.equal(foldHours(['Open by appointment']), 'Open by appointment');
  });

  it('returns nothing for empty or junk research', () => {
    assert.deepEqual(extractFacts(null), []);
    assert.deepEqual(extractFacts({ site: { pages: 'x' } }), []);
    assert.deepEqual(extractFacts({ site: { pages: [{ url: HOME, text: '<script>alert(1)</script>' }] } }), []);
  });
});
