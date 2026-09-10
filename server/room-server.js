/**
 * 象棋联机房间服务器（零第三方依赖，Node >= 12）
 *
 * 启动：node server/room-server.js [port]   默认 8787
 * 部署：nginx 将 wss://你的域名/ws 反代到 http://127.0.0.1:8787/ws
 *
 * 职责极简：WebSocket 握手 + 帧收发 + 房间中继（server/relay.js）。
 * 消息体即客户端协议（net/session.js）：{room, clientId, type, ...}，
 * 服务端按 msg.room 路由广播，不解析棋局、不做裁判（校验在客户端本地完成）。
 */
var http = require('http');
var crypto = require('crypto');
var url = require('url');
var Relay = require('./relay.js');

var PORT = parseInt(process.argv[2], 10) || 8787;
var MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

var relay = new Relay();

// ---------------------------------------------------------------------------
// WebSocket 帧编解码（仅支持文本/关闭/ping，足够本协议）
// ---------------------------------------------------------------------------

function encodeText(str) {
  var payload = Buffer.from(str, 'utf8');
  var len = payload.length;
  var header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, payload]);
}

function encodeFrame(opcode, payload) {
  payload = payload || Buffer.alloc(0);
  var header = Buffer.alloc(2);
  header[0] = 0x80 | opcode;
  header[1] = payload.length; // 服务端->客户端 不需掩码，且控制帧 payload 极短
  return Buffer.concat([header, payload]);
}

/** 从缓冲中解出完整帧；返回 {opcode, payload, consumed} 或 null */
function parseFrame(buf) {
  if (buf.length < 2) return null;
  var opcode = buf[0] & 0x0f;
  var masked = (buf[1] & 0x80) !== 0;
  var len = buf[1] & 0x7f;
  var offset = 2;
  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset); offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    len = buf.readUInt32BE(offset + 4); offset += 8; // 忽略高 32 位（远超需求）
  }
  var maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return null;
  var mask = masked ? buf.slice(offset, offset + 4) : null;
  offset += maskLen;
  var payload = Buffer.alloc(len);
  for (var i = 0; i < len; i++) {
    payload[i] = masked ? buf[offset + i] ^ mask[i % 4] : buf[offset + i];
  }
  return { opcode: opcode, payload: payload, consumed: offset + len };
}

// ---------------------------------------------------------------------------
// 连接包装
// ---------------------------------------------------------------------------

function wrapSocket(socket) {
  var sock = {
    alive: true,
    buf: Buffer.alloc(0),
    send: function (obj) {
      if (!sock.alive) return;
      try { socket.write(encodeText(JSON.stringify(obj))); } catch (e) { sock.alive = false; }
    },
    close: function () {
      if (!sock.alive) return;
      sock.alive = false;
      try { socket.write(encodeFrame(0x8)); socket.end(); } catch (e) {}
    }
  };

  socket.on('data', function (chunk) {
    sock.buf = Buffer.concat([sock.buf, chunk]);
    for (;;) {
      var frame = parseFrame(sock.buf);
      if (!frame) break;
      sock.buf = sock.buf.slice(frame.consumed);
      if (frame.opcode === 0x8) { sock.close(); return; }        // close
      if (frame.opcode === 0x9) { socket.write(encodeFrame(0xa, frame.payload)); continue; } // ping->pong
      if (frame.opcode === 0x1) {                                  // text
        var msg = null;
        try { msg = JSON.parse(frame.payload.toString('utf8')); } catch (e) { msg = null; }
        if (msg && msg.room) {
          relay.add(msg.room, sock);
          relay.broadcast(msg.room, msg);
        }
      }
    }
  });
  socket.on('close', function () { sock.alive = false; relay.remove(sock); });
  socket.on('error', function () { sock.alive = false; relay.remove(sock); });
  return sock;
}

// ---------------------------------------------------------------------------
// HTTP + 握手
// ---------------------------------------------------------------------------

var server = http.createServer(function (req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('chess room server');
});

server.on('upgrade', function (req, socket) {
  var key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  // 房间随握手声明：?room=XXX，登记后该连接即可收到房间广播
  var room = '';
  try {
    var q = url.parse(req.url, true).query;
    room = q.room || '';
  } catch (e) { room = ''; }
  var accept = crypto.createHash('sha1').update(key + MAGIC).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  var sock = wrapSocket(socket);
  if (room) relay.add(room, sock);
});

server.listen(PORT, function () {
  console.log('chess room server listening on :' + PORT);
});

module.exports = { server: server, relay: relay, encodeText: encodeText, parseFrame: parseFrame };
