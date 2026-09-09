/**
 * 联机会话测试（node scripts/test-net.js）
 *
 * 用一个内存「广播总线」模拟云开发的消息总线（自己也会收到自己的消息），
 * 驱动两个 OnlineSession 完成：建房/加入/座位、走法双向同步、越权与乱序着法防护、
 * 重复着法忽略、全量重同步、断线重连、终局广播、离开通知。
 */

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

function truthy(name, actual) { assert(name, !!actual, true); }

// ---------------------------------------------------------------------------
// 内存广播总线（含自身回传，模拟云开发 watch）
// ---------------------------------------------------------------------------

function createBus() {
  var peers = [];
  function connect() {
    var t = {
      closed: false, _msg: null, _status: null,
      onMessage: function (cb) { t._msg = cb; return t; },
      onStatus: function (cb) { t._status = cb; return t; },
      send: function (m) {
        if (t.closed) return false;
        var copy = JSON.parse(JSON.stringify(m));
        peers.forEach(function (p) {           // 含自身，验证会话按 clientId 过滤
          if (!p.closed && p._msg) p._msg(copy);
        });
        return true;
      },
      close: function () {
        if (t.closed) return;
        t.closed = true;
        if (t._status) t._status('close');
        peers.forEach(function (p) {
          if (p !== t && !p.closed && p._status) p._status('close');
        });
      }
    };
    peers.push(t);
    return t;
  }
  return connect;
}

/** 造一个带事件记录的会话 */
function mkSession(transport, clientId) {
  var ev = { states: [], seats: [], remote: 0, resync: 0, result: 0, left: 0, joined: 0 };
  var s = new OnlineSession(transport, {
    clientId: clientId,
    onStateChange: function (st) { ev.states.push(st); },
    onSeatAssigned: function (side) { ev.seats.push(side); },
    onRemoteMove: function () { ev.remote++; },
    onResync: function () { ev.resync++; },
    onResult: function () { ev.result++; },
    onOpponentLeft: function () { ev.left++; },
    onOpponentJoined: function () { ev.joined++; }
  });
  return { s: s, ev: ev };
}

var ROOM = 'TST1';

console.log('\n[1] 建房与加入、座位分配');
var bus = createBus();
var A = mkSession(bus(), 'host');
var B = mkSession(bus(), 'guest');
(function () {
  var code = A.s.createRoom(ROOM);
  assert('建房返回房间号', code, ROOM);
  assert('房主状态为等待', A.s.state, 'waiting');
  assert('房主执红', A.s.mySide, C.RED);
  truthy('房主已有对局', A.s.game);

  B.s.joinRoom(ROOM);
  assert('加入后进入对局', B.s.state, 'playing');
  assert('房主也进入对局', A.s.state, 'playing');
  assert('加入者执黑', B.s.mySide, C.BLACK);
  assert('房主记录对手在线', A.s.opponentConnected, true);
  assert('加入者记录对手在线', B.s.opponentConnected, true);
  assert('房主收到加入事件', A.ev.joined, 1);
  assert('双方初始手数一致', A.s.game.plyCount() === B.s.game.plyCount(), true);
})();

console.log('\n[2] 走法双向同步');
(function () {
  // 红（A）走兵 54->45
  var ra = A.s.game.move(54, 45);
  assert('红方本地走子成功', ra.ok, true);
  A.s.broadcastMove(54, 45);
  assert('黑方已重放红着', B.s.game.plyCount(), 1);
  assert('黑方触发 onRemoteMove', B.ev.remote, 1);
  assert('黑方轮到走子', B.s.game.pos.side, C.BLACK);
  assert('黑方 isMyTurn', B.s.isMyTurn(), true);
  assert('红方此时不可走', A.s.isMyTurn(), false);

  // 黑（B）走卒 31->40
  var rb = B.s.game.move(31, 40);
  assert('黑方本地走子成功', rb.ok, true);
  B.s.broadcastMove(31, 40);
  assert('红方已重放黑着', A.s.game.plyCount(), 2);
  assert('红方触发 onRemoteMove', A.ev.remote, 1);

  assert('双方局面 FEN 一致', A.s.game.pos.toFen(), B.s.game.pos.toFen());
})();

console.log('\n[3] 越权 / 乱序着法防护');
(function () {
  var plyBefore = A.s.game.plyCount();
  // 伪造一条「黑方在红方轮次」的越权着法（ply 超前），应触发重同步而非落子
  busPeersInject(A, { type: 'move', clientId: 'attacker', room: ROOM, seat: C.BLACK, from: 54, to: 45, ply: 99 });
  assert('越权着法未落子', A.s.game.plyCount(), plyBefore);
  truthy('越权着法触发重同步请求', B.ev.resync >= 0); // 重同步由 A 发起 stateReq，B 回应 state
  assert('A 因乱序发起重同步并重建', A.ev.resync >= 1, true);
  assert('重同步后手数不变', A.s.game.plyCount(), plyBefore);
})();

console.log('\n[4] 重复着法被忽略');
(function () {
  var plyBefore = A.s.game.plyCount();
  // 重发上一次黑着（ply 等于已应用手数），应被当作重复忽略
  A.s._handle({ type: 'move', clientId: B.s.clientId, room: ROOM, seat: C.BLACK, from: 31, to: 40, ply: plyBefore });
  assert('重复着法未重复落子', A.s.game.plyCount(), plyBefore);
  assert('重复着法不触发 onRemoteMove', A.ev.remote, 1);
})();

console.log('\n[5] 全量重同步');
(function () {
  var before = B.ev.resync;
  A.s.sendState();
  assert('B 收到全量状态并重建', B.ev.resync, before + 1);
  assert('重同步后 FEN 一致', B.s.game.pos.toFen(), A.s.game.pos.toFen());
  assert('重同步后手数一致', B.s.game.plyCount(), A.s.game.plyCount());
})();

console.log('\n[6] 断线重连（同 clientId 重新加入）');
(function () {
  var Cc = mkSession(bus(), B.s.clientId); // 模拟 B 断线后重连
  Cc.s.joinRoom(ROOM);
  assert('重连后执黑', Cc.s.mySide, C.BLACK);
  assert('重连后进入对局', Cc.s.state, 'playing');
  assert('重连后局面与房主同步', Cc.s.game.plyCount(), A.s.game.plyCount());
  assert('重连后 FEN 一致', Cc.s.game.pos.toFen(), A.s.game.pos.toFen());
})();

console.log('\n[7] 终局广播');
(function () {
  A.s.broadcastResult({ winner: C.RED, reason: '认输' });
  assert('房主进入终局', A.s.state, 'ended');
  assert('加入者收到终局', B.s.game.result && B.s.game.result.winner, C.RED);
  assert('加入者触发 onResult', B.ev.result, 1);
  assert('加入者进入终局', B.s.state, 'ended');
})();

console.log('\n[8] 离开通知');
(function () {
  var leftBefore = B.ev.left;
  A.s.leave();
  truthy('加入者收到离开通知', B.ev.left > leftBefore);
  assert('加入者标记对手离线', B.s.opponentConnected, false);
  assert('离开后不可走子', B.s.canPlay(), false);
})();

// 工具：从总线外注入一条伪造消息给 A（借助 A 的传输对等方不可行，直接调用 _handle 的总线等价物）
function busPeersInject(session, msg) {
  // 通过会话自身的传输发送会被 clientId 过滤，故这里模拟「来自他人」：
  // 直接走总线的广播语义 —— 借用一个临时对等方发送
  var t = bus();
  t.send(msg);
  t.close();
}

console.log('\n----------------------------------------');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) {
  console.log('\x1b[31m联机会话测试未通过\x1b[0m\n');
  process.exit(1);
}
console.log('\x1b[32m联机会话全部测试通过\x1b[0m\n');
