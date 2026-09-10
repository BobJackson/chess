/**
 * 自建 WebSocket 通道测试（node scripts/test-ws.js）
 *
 * 三层验证：
 *  1. server/relay.js 房间中继纯逻辑（加入/广播/移除/计数）
 *  2. net/ws-transport.js 适配器（open 前排队、open 后 flush、自身消息过滤、close 状态）
 *  3. 集成：内存假服务端（relay 路由）+ 两个 WsTransport + OnlineSession 跑通
 *     建房/加入/走法同步/离开，等价于 server/room-server.js 的中继语义。
 */
var Relay = require('../server/relay.js');
var WsTransport = require('../miniprogram/net/ws-transport.js');
var OnlineSession = require('../miniprogram/net/session.js');
var C = require('../miniprogram/core/constants.js');

var passed = 0;
var failed = 0;
function assert(name, actual, expected) {
  if (actual === expected) {
    passed++;
    console.log('  \x1b[32mPASS\x1b[0m  ' + name + ' = ' + JSON.stringify(actual));
  } else {
    failed++;
    console.log('  \x1b[31mFAIL\x1b[0m  ' + name +
      ' 期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  }
}
function truthy(name, v) { assert(name, !!v, true); }
function flush() { return new Promise(function (r) { setImmediate(r); }); }

// ---------------------------------------------------------------------------
// 内存假服务端：等价 room-server.js 的中继语义（按 msg.room 路由广播）
// ---------------------------------------------------------------------------
function makeFakeServer() {
  var relay = new Relay();
  function connect(opts) {
    var handlers = {};
    var serverSock = {
      send: function (obj) {
        if (handlers.message) handlers.message({ data: JSON.stringify(obj) });
      }
    };
    // 与 room-server 一致：握手 URL 带 ?room=，立即登记进房间
    var m = /room=([^&]+)/.exec((opts && opts.url) || '');
    if (m) relay.add(decodeURIComponent(m[1]), serverSock);
    var client = {
      onOpen: function (cb) { handlers.open = cb; },
      onMessage: function (cb) { handlers.message = cb; },
      onClose: function (cb) { handlers.close = cb; },
      onError: function (cb) { handlers.error = cb; },
      send: function (arg) {
        var msg = JSON.parse(arg.data);
        if (msg.room) relay.add(msg.room, serverSock);
        relay.broadcast(msg.room, msg);
      },
      close: function () {
        relay.remove(serverSock);
        if (handlers.close) handlers.close({});
      }
    };
    setImmediate(function () { if (handlers.open) handlers.open({}); });
    return client;
  }
  return { relay: relay, connect: connect };
}

// ---------------------------------------------------------------------------

(async function main() {
  console.log('\n[1] relay 房间中继');
  (function () {
    var r = new Relay();
    var gotA = [], gotB = [];
    var a = { send: function (m) { gotA.push(m); } };
    var b = { send: function (m) { gotB.push(m); } };
    r.add('R1', a); r.add('R1', b);
    assert('房间连接数', r.count('R1'), 2);
    r.broadcast('R1', { t: 1 });
    assert('广播到 A', gotA.length, 1);
    assert('广播到 B', gotB.length, 1);
    r.broadcast('R1', { t: 2 }, a);
    assert('except 排除 A', gotA.length, 1);
    assert('B 仍收到', gotB.length, 2);
    r.remove(a);
    assert('移除后连接数', r.count('R1'), 1);
    r.remove(b);
    assert('空房间回收', r.count('R1'), 0);
  })();

  console.log('\n[2] ws-transport 适配器');
  (function () {
    var sent = [];
    var incoming = [];
    var statuses = [];
    var handlers = {};
    global.wx = {
      connectSocket: function () {
        return {
          onOpen: function (cb) { handlers.open = cb; },
          onMessage: function (cb) { handlers.message = cb; },
          onClose: function (cb) { handlers.close = cb; },
          onError: function (cb) { handlers.error = cb; },
          send: function (arg) { sent.push(JSON.parse(arg.data)); },
          close: function () {}
        };
      }
    };
    var t = new WsTransport({ clientId: 'me', url: 'wss://x/ws' });
    t.onMessage(function (m) { incoming.push(m); });
    t.onStatus(function (s) { statuses.push(s); });
    t.attach('RM1');
    // open 之前 send 应排队
    t.send({ type: 'join', room: 'RM1' });
    assert('open 前消息排队', sent.length, 0);
    handlers.open();
    assert('open 后 flush', sent.length, 1);
    assert('flush 带 clientId', sent[0].clientId, 'me');
    assert('状态 open', statuses.indexOf('open') >= 0, true);
    // 他人消息投递、自身过滤
    handlers.message({ data: JSON.stringify({ type: 'move', clientId: 'other', room: 'RM1' }) });
    handlers.message({ data: JSON.stringify({ type: 'move', clientId: 'me', room: 'RM1' }) });
    assert('仅他人消息投递', incoming.length, 1);
    handlers.close();
    assert('close 状态', statuses[statuses.length - 1], 'close');
  })();

  console.log('\n[3] 集成：假服务端 + 双会话同步');
  var server = makeFakeServer();
  global.wx = { connectSocket: server.connect };

  var tA = new WsTransport({ clientId: 'A', url: 'wss://x/ws' });
  var tB = new WsTransport({ clientId: 'B', url: 'wss://x/ws' });
  var evB = { remote: 0, left: 0 };
  var sA = new OnlineSession(tA, { clientId: 'A' });
  var sB = new OnlineSession(tB, {
    clientId: 'B',
    onRemoteMove: function () { evB.remote++; },
    onOpponentLeft: function () { evB.left++; }
  });

  tA.attach('WS01');
  sA.createRoom('WS01');
  tB.attach('WS01');
  sB.joinRoom('WS01');
  await flush(); await flush();
  assert('房主进入对局', sA.state, 'playing');
  assert('加入者进入对局', sB.state, 'playing');
  assert('房主执红', sA.mySide, C.RED);
  assert('加入者执黑', sB.mySide, C.BLACK);

  sA.game.move(54, 45);
  sA.broadcastMove(54, 45);
  await flush();
  assert('黑方经 ws 收到红着', sB.game.plyCount(), 1);
  assert('触发 onRemoteMove', evB.remote, 1);
  sB.game.move(31, 40);
  sB.broadcastMove(31, 40);
  await flush();
  assert('红方经 ws 收到黑着', sA.game.plyCount(), 2);
  assert('双方 FEN 一致', sA.game.pos.toFen(), sB.game.pos.toFen());

  sA.leave();
  await flush();
  assert('加入者收到离开通知', evB.left, 1);

  console.log('\n----------------------------------------');
  console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  if (failed > 0) {
    console.log('\x1b[31mWS 通道测试未通过\x1b[0m\n');
    process.exit(1);
  }
  console.log('\x1b[32mWS 通道全部测试通过\x1b[0m\n');
  process.exit(0);
})().catch(function (e) {
  console.error('测试异常:', e);
  process.exit(1);
});
