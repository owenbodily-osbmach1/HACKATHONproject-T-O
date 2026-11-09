// STUB (card A fills this in). WebSocket hub for /ws?room=&role=&key= (CONTRACT.md "WebSocket").
// Interface other modules rely on — keep these names:
//   attach(server, ctx)                 called once at startup
//   handleUpgrade(req, socket, head)    called by index.js for path /ws
//   send(room, msg, roles?)             JSON-send msg to every socket in room (optionally only these roles)
//   sendTo(clientIds, room, msg)        JSON-send to sockets whose clientId is in the array (question_reply)
//   listeners(room)                     number of open attendee sockets in room
//   on(t, fn)                           subscribe to inbound messages: fn(msg, {room, role, clientId})
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ noServer: true });
module.exports = {
  attach() {},
  handleUpgrade(req, socket, head) { wss.handleUpgrade(req, socket, head, (ws) => ws.close(1013)); },
  send() {},
  sendTo() {},
  listeners() { return 0; },
  on() {},
};
