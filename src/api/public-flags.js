// Public read of the two chat flags. No API key. No other flag and no metadata.

const express = require('express');
const { effective } = require('../flags/resolve');

const router = express.Router();

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.status(404);
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.end('{"error":"not_found"}');
    return;
  }
  next();
});

router.get('/', async (req, res) => {
  let gallery = false;
  let demo = false;
  try {
    const [galleryView, demoView] = await Promise.all([
      effective('FF_PROTOTYPE_GALLERY'),
      effective('FF_LIVE_CHAT_DEMO'),
    ]);
    gallery = galleryView.effective === true;
    demo = demoView.effective === true;
  } catch (err) {
    gallery = false;
    demo = false;
  }
  res.status(200);
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({
    FF_PROTOTYPE_GALLERY: gallery,
    FF_LIVE_CHAT_DEMO: demo,
  }));
});

module.exports = router;
