// STUB (card A fills this in). Binary audio relay: /ws/audio-in?room=&key=SPEAKER_KEY -> /ws/audio-out?room= (CONTRACT.md "Audio").
// Interface: attach(server, ctx), handleUpgrade(req, socket, head), micDb(room) -> latest dBFS or null.
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ noServer: true });
module.exports = {
  attach() {},
  handleUpgrade(req, socket, head) { wss.handleUpgrade(req, socket, head, (ws) => ws.close(1013)); },
  micDb() { return null; },
};
