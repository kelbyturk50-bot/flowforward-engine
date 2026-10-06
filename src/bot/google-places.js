// Google Places API (New) — Text Search wrapper
// Docs: https://developers.google.com/maps/documentation/places/web-service/text-search

const axios = require('axios');

const BASE = 'https://places.googleapis.com/v1/places:searchText';

// Fields we want back — only request what we use (reduces cost)
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.nationalPhoneNumber',
  'places.websiteUri',
  'places.rating',
  'places.userRatingCount',
  'places.businessStatus',
  'places.addressComponents',
].join(',');

/**
 * Search Google Places for businesses matching a text query in a location.
 *
 * @param {string} query       e.g. "HVAC company"
 * @param {string} location    e.g. "Salt Lake City UT"
 * @param {number} maxResults  1–20 (API max per request)
 * @returns {Array} raw place objects
 */
async function searchPlaces(query, location, maxResults = 20) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error('GOOGLE_PLACES_API_KEY is not set');

  const textQuery = `${query} in ${location}`;

  const res = await axios.post(
    BASE,
    {
      textQuery,
      maxResultCount: Math.min(maxResults, 20),
      languageCode: 'en',
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      timeout: 15000,
    }
  );

  return res.data.places || [];
}

/**
 * Normalize a raw Google Place object into our DB shape.
 */
function normalizePplace(place, industry, defaultScore) {
  const name = place.displayName?.text || 'Unknown';
  const address = place.formattedAddress || '';

  // Extract city/state/zip from address components
  let city = '', state = '', zip = '';
  if (place.addressComponents) {
    for (const comp of place.addressComponents) {
      if (comp.types.includes('locality'))                  city  = comp.longText;
      if (comp.types.includes('administrative_area_level_1')) state = comp.shortText;
      if (comp.types.includes('postal_code'))               zip   = comp.longText;
    }
  }

  return {
    google_place_id: place.id,
    company:         name,
    industry:        industry,
    phone:           place.nationalPhoneNumber || null,
    website:         place.websiteUri || null,
    address:         address,
    city:            city,
    state:           state,
    zip:             zip,
    rating:          place.rating || null,
    review_count:    place.userRatingCount || 0,
    score:           defaultScore,
    source:          'google_places',
    stage:           'found',
  };
}

module.exports = { searchPlaces, normalizePplace };
