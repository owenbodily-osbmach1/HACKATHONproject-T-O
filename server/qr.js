// GET /qr/:room.gif -> QR code image for the room's phone page, so a deck (Google Slides,
// PowerPoint) can insert the join code by URL. Points at PUBLIC_BASE_URL if set, otherwise
// at the public origin this request came through (tunnel / ingress).
const qrcode = require('../public/vendor/qrcode.js');

function baseUrl(req, config) {
  if (config.PUBLIC_BASE_URL) return config.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  return `${proto}://${req.get('host')}`;
}

module.exports = {
  register(app, ctx) {
    app.get('/qr/:file', (req, res) => {
      const m = /^([A-Za-z0-9_-]{1,32})\.gif$/.exec(req.params.file);
      if (!m) return res.status(404).end();
      const url = `${baseUrl(req, ctx.config)}/r/${m[1]}`;
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      const gif = Buffer.from(qr.createDataURL(16, 4).split(',')[1], 'base64');
      res.set('Content-Type', 'image/gif');
      res.set('Cache-Control', 'no-store'); // the public URL can change between runs
      res.set('X-Pulse-QR-Target', url);
      res.send(gif);
    });
  },
};
