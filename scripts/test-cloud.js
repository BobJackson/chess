/**
 * 云开发传输集成测试（node scripts/test-cloud.js）
 *
 * 用内存假云（chess_rooms / chess_msgs 两集合 + watch 广播总线）模拟 wx.cloud.database，
 * 真实加载 net/cloud-transport.js 与 net/session.js，跑通：
 *   建房登记 -> 加入校验 -> 座位分配 -> 走法双向同步 -> 全量重同步 -> 离开通知 -> 房间清理。
 * 目的：在不连真云的前提下验证云适配器与协议层的接线正确性。
 */
var CloudTransport = require('../miniprogram/net/cloud-transport.js');
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

// ---------------------------------------------------------------------------
// 内存假云
// ---------------------------------------------------------------------------
function createFakeCloud() {
  var rooms = {};
  var msgs = [];
  var watchers = [];
  var seq = 0;

  function notify(room) {
    watchers.slice().forEach(function (w) {
      if (w.room === room && w.onChange) {
        w.onChange({ type: 'queue', docs: msgs.filter(function (m) { return m.room === room; }) });
      }
    });
  }

  var db = {
    collection: function (name) {
      if (name === 'chess_rooms') {
        return {
          add: function (arg) {
            var d = arg.data;
            if (rooms[d._id]) return Promise.reject(new Error('duplicate'));
            rooms[d._id] = d;
            return Promise.resolve({ _id: d._id });
          },
          doc: function (id) {
            return {
              get: function () {
                return rooms[id] ? Promise.resolve({ data: rooms[id] }) : Promise.reject(new Error('not found'));
              },
              remove: function () {
                if (rooms[id]) delete rooms[id];
                return Promise.resolve({});
              }
            };
          }
        };
      }
      return {
        add: function (arg) {
          var d = arg.data;
          d._id = 'm' + (++seq);
          msgs.push(d);
          notify(d.room);
          return Promise.resolve({ _id: d._id });
        },
        where: function (q) {
          return {
            watch: function (handlers) {
              var w = { room: q.room, onChange: handlers.onChange };
              watchers.push(w);
              // init 快照：历史消息（适配器只标记不回放）
              handlers.onChange({ type: 'init', docs: msgs.filter(function (m) { return m.room === q.room; }) });
              return {
                close: function () {
                  var i = watchers.indexOf(w);
                  if (i >= 0) watchers.splice(i, 1);
                }
              };
            }
          };
        }
      };
    }
  };
  return { db: db, rooms: rooms, msgs: msgs };
}

function mkSession(transport, id) {
  var ev = { resync: 0, remote: 0, left: 0, joined: 0 };
  var s = new OnlineSession(transport, {
    clientId: id,
    onResync: function () { ev.resync++; },
    onRemoteMove: function () { ev.remote++; },
    onOpponentLeft: function () { ev.left++; },
    onOpponentJoined: function () { ev.joined++; }
  });
  return { s: s, ev: ev };
}

// ---------------------------------------------------------------------------

(async function main() {
  var fake = createFakeCloud();
  global.wx = { cloud: { database: function () { return fake.db; } } };

  console.log('\n[1] 建房登记与加入校验');
  var tA = new CloudTransport({ clientId: 'A' });
  await tA.createRoomDoc('ABCD');
  truthy('房间文档已登记', fake.rooms['ABCD']);
  assert('创建者记录', fake.rooms['ABCD'].creator, 'A');

  var dup = true;
  var tDup = new CloudTransport({ clientId: 'X' });
  await tDup.createRoomDoc('ABCD').catch(function () { dup = false; });
  assert('重复房号被拒绝', dup, false);

  var tB = new CloudTransport({ clientId: 'B' });
  assert('加入前校验存在', await tB.roomExists('ABCD'), true);
  assert('不存在的房号校验为 false', await tB.roomExists('ZZZZ'), false);

  console.log('\n[2] 会话接入与座位');
  tA.attach('ABCD');
  var A = mkSession(tA, 'A');
  A.s.createRoom('ABCD');
  assert('房主等待中', A.s.state, 'waiting');

  tB.attach('ABCD');
  var B = mkSession(tB, 'B');
  B.s.joinRoom('ABCD');
  assert('房主进入对局', A.s.state, 'playing');
  assert('加入者进入对局', B.s.state, 'playing');
  assert('房主执红', A.s.mySide, C.RED);
  assert('加入者执黑', B.s.mySide, C.BLACK);
  assert('房主收到加入事件', A.ev.joined, 1);

  console.log('\n[3] 走法经云总线双向同步');
  A.s.game.move(54, 45);
  A.s.broadcastMove(54, 45);
  assert('黑方经云收到红着', B.s.game.plyCount(), 1);
  assert('黑方触发 onRemoteMove', B.ev.remote, 1);
  B.s.game.move(31, 40);
  B.s.broadcastMove(31, 40);
  assert('红方经云收到黑着', A.s.game.plyCount(), 2);
  assert('双方 FEN 一致', A.s.game.pos.toFen(), B.s.game.pos.toFen());

  console.log('\n[4] 全量重同步');
  var before = B.ev.resync;
  B.s.requestState();
  assert('房主回应状态后加入者重建', B.ev.resync, before + 1);
  assert('重同步后 FEN 一致', B.s.game.pos.toFen(), A.s.game.pos.toFen());

  console.log('\n[5] 离开通知与房间清理');
  A.s.leave();
  assert('加入者收到离开通知', B.ev.left, 1);
  assert('加入者标记对手离线', B.s.opponentConnected, false);
  await tA.removeRoom('ABCD');
  truthy('房间文档已删除', !fake.rooms['ABCD']);
  assert('删除后校验为 false', await tB.roomExists('ABCD'), false);

  console.log('\n----------------------------------------');
  console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  if (failed > 0) {
    console.log('\x1b[31m云传输测试未通过\x1b[0m\n');
    process.exit(1);
  }
  console.log('\x1b[32m云传输全部测试通过\x1b[0m\n');
})().catch(function (e) {
  console.error('测试异常:', e);
  process.exit(1);
});
