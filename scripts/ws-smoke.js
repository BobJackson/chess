/**
 * 联机中继真实冒烟（node scripts/ws-smoke.js [wsUrl]）
 *
 * 用两个裸 WebSocket 客户端（手写握手与帧编解码，无第三方依赖）连到运行中的
 * room-server，验证：握手 ?room= 登记、同房间广播、跨房间隔离。
 * 先启动服务端：docker run -p 127.0.0.1:18787:8787 chess-room  或  node server/room-server.js 18787
 */
var net = require('net');
var tls = require('tls');
var crypto = require('crypto');
var urlMod = require('url');

var TARGET = process.argv[2] || 'ws://127.0.0.1:18787/ws';

function connect(room, clientId) {
  return new Promise(function (resolve, reject) {
    var u = urlMod.parse(TARGET + '?room=' + room);
    var useTls = (u.protocol === 'wss:' || u.protocol === 'https:');
    var host = u.hostname;
    var port = parseInt(u.port, 10) || (useTls ? 443 : 80);
    var key = crypto.randomBytes(16).toString('base64');
    var onConnect = function () {
      sock.write(
        'GET ' + (u.pathname || '/') + '?room=' + room + ' HTTP/1.1\r\n' +
        'Host: ' + host + ':' + port + '\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n'
      );
    };
    // wss 走 TLS（默认 443），ws 走明文 TCP（默认 80）
    var sock = useTls
      ? tls.connect(port, host, { servername: host }, onConnect)
      : net.connect(port, host, onConnect);
    var buf = Buffer.alloc(0);
    var handshaken = false;
    var client = {
      messages: [],
      send: function (obj) {
        var payload = Buffer.from(JSON.stringify(obj), 'utf8');
        var mask = crypto.randomBytes(4);
        var header;
        if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
        else if (payload.length < 65536) {
          header = Buffer.alloc(4);
          header[0] = 0x81; header[1] = 0x80 | 126;
          header.writeUInt16BE(payload.length, 2);
        } else {
          header = Buffer.alloc(10);
          header[0] = 0x81; header[1] = 0x80 | 127;
          header.writeUIntBE(payload.length, 2, 8);
        }
        var masked = Buffer.alloc(payload.length);
        for (var i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
        sock.write(Buffer.concat([header, mask, masked]));
      },
      close: function () { sock.destroy(); }
    };
    sock.on('data', function (chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (!handshaken) {
        var idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        var head = buf.slice(0, idx).toString();
        buf = buf.slice(idx + 4);
        if (!/101/.test(head)) { reject(new Error('handshake failed: ' + head.split('\r\n')[0])); return; }
        handshaken = true;
        resolve(client);
      }
      // 解析服务端帧（未掩码）
      while (buf.length >= 2) {
        var b0 = buf[0];
        var len = buf[1] & 0x7f;
        var off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) break; len = buf.readUIntBE(2, 8); off = 10; }
        if (buf.length < off + len) break;
        var payload = buf.slice(off, off + len);
        buf = buf.slice(off + len);
        var op = b0 & 0x0f;
        if (op === 1) {
          try { client.messages.push(JSON.parse(payload.toString('utf8'))); } catch (e) {}
        }
      }
    });
    sock.on('error', reject);
  });
}

function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

(async function () {
  var a = await connect('SMK1', 'A');
  var b = await connect('SMK1', 'B');
  var c = await connect('SMK2', 'C');
  a.send({ room: 'SMK1', clientId: 'A', type: 'join' });
  b.send({ room: 'SMK1', clientId: 'B', type: 'join' });
  c.send({ room: 'SMK2', clientId: 'C', type: 'join' });
  await wait(200);
  a.send({ room: 'SMK1', clientId: 'A', type: 'move', from: 54, to: 45, ply: 1 });
  await wait(300);

  var bGot = b.messages.some(function (m) { return m.type === 'move' && m.clientId === 'A'; });
  var cGot = c.messages.some(function (m) { return m.type === 'move'; });
  console.log('同房间 B 收到 A 的 move: ' + bGot);
  console.log('跨房间 C 未收到(应为 false): ' + cGot);
  a.close(); b.close(); c.close();
  if (bGot && !cGot) { console.log('WS 冒烟通过'); process.exit(0); }
  console.log('WS 冒烟失败'); process.exit(1);
})().catch(function (e) { console.error('冒烟异常:', e.message); process.exit(1); });
