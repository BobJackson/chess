/**
 * 松桂账本测试（node scripts/test-ledger.js）
 *
 * 覆盖：记账映射（本地红=松 / 联机本机=松 / 人机不入账）、胜负和统计、
 * 存储读写往返、脏数据回退、菜单文案、清零。
 */

var Ledger = require('../miniprogram/core/ledger.js');
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

/** 内存存储适配器（模拟 wx.*StorageSync） */
function memStorage() {
  var data = {};
  return {
    data: data,
    get: function (k) { return data[k] || null; },
    set: function (k, v) { data[k] = v; }
  };
}

function resultOf(winner, text) {
  return { winner: winner, reason: '将死', text: text || '绝杀无解，红方胜' };
}

console.log('\n[1] outcomeFor 映射');
(function () {
  // 本地双人：红 = 松，黑 = 桂
  assert('本地红胜记松', Ledger.outcomeFor('local', resultOf(C.RED)), 'song');
  assert('本地黑胜记桂', Ledger.outcomeFor('local', resultOf(C.BLACK)), 'gui');
  assert('本地和棋', Ledger.outcomeFor('local', resultOf(-1)), 'draw');
  // 联机：本机方 = 松
  assert('联机本机胜记松', Ledger.outcomeFor('online', resultOf(C.RED), C.RED), 'song');
  assert('联机对方胜记桂', Ledger.outcomeFor('online', resultOf(C.BLACK), C.RED), 'gui');
  assert('联机执黑时本机胜仍记松', Ledger.outcomeFor('online', resultOf(C.BLACK), C.BLACK), 'song');
  assert('联机和棋', Ledger.outcomeFor('online', resultOf(-1), C.RED), 'draw');
  // 人机不入账；无结果不入账
  assert('人机不入账', Ledger.outcomeFor('ai', resultOf(C.RED)), null);
  assert('无结果不入账', Ledger.outcomeFor('local', null), null);
  assert('未知模式不入账', Ledger.outcomeFor('???', resultOf(C.RED)), null);
})();

console.log('\n[2] 记账与汇总');
(function () {
  var st = memStorage();
  var ledger = Ledger.create(st);

  var s0 = ledger.summary();
  assert('初始总局数 0', s0.total, 0);
  assert('初始比分行', ledger.line(), '松桂账本 · 待首局开枰');
  assert('初始无最近局', ledger.lastLine(), '');

  ledger.record({ mode: 'local', result: resultOf(C.RED), when: Date.UTC(2026, 8, 20) });
  ledger.record({ mode: 'local', result: resultOf(C.RED), when: Date.UTC(2026, 8, 21) });
  ledger.record({ mode: 'online', result: resultOf(C.BLACK), humanSide: C.RED, when: Date.UTC(2026, 8, 22) });
  ledger.record({ mode: 'local', result: resultOf(-1, '双方不变作和'), when: Date.UTC(2026, 8, 23) });
  // 人机局不应改变账本
  assert('人机记账返回 null', ledger.record({ mode: 'ai', result: resultOf(C.RED) }), null);

  var s = ledger.summary();
  assert('总局数 4', s.total, 4);
  assert('松 2 胜', s.song, 2);
  assert('桂 1 胜', s.gui, 1);
  assert('和 1 局', s.draws, 1);
  assert('比分行', ledger.line(), '松 2 : 1 桂 · 和 1');

  var last = s.last;
  assert('最近局为和棋', last.outcome, 'draw');
  assert('最近局模式', last.mode, 'local');
  assert('最近局文案', ledger.lastLine().indexOf('上局 和棋 · 双人'), 0);

  // 无和棋时比分行不带「和」
  var st2 = memStorage();
  var l2 = Ledger.create(st2);
  l2.record({ mode: 'local', result: resultOf(C.RED) });
  assert('无和棋比分行', l2.line(), '松 1 : 0 桂');
})();

console.log('\n[3] 存储往返与脏数据');
(function () {
  var st = memStorage();
  var a = Ledger.create(st);
  a.record({ mode: 'online', result: resultOf(C.RED), humanSide: C.RED, when: Date.UTC(2026, 8, 24) });

  // 新实例从同一份存储读出（模拟下次启动）
  var b = Ledger.create(st);
  assert('重开读到总局数', b.summary().total, 1);
  assert('重开读到比分', b.line(), '松 1 : 0 桂');

  // 脏数据：类型不对回退空账本，不抛异常
  st.data[Ledger.KEY] = 'garbage';
  var c = Ledger.create(st);
  assert('脏字符串回退空账本', c.summary().total, 0);
  st.data[Ledger.KEY] = { total: -5, song: 'x', last: { t: 'not-a-number' } };
  var d = Ledger.create(st);
  assert('脏对象字段清零', d.summary().total, 0);
  assert('脏对象忽略 last', d.summary().last, null);

  // 存储抛异常时降级为内存账，不影响记账
  var broken = {
    get: function () { throw new Error('io'); },
    set: function () { throw new Error('io'); }
  };
  var e = Ledger.create(broken);
  assert('坏存储仍能记账', e.record({ mode: 'local', result: resultOf(C.RED) }), 'song');
  assert('坏存储内存汇总', e.summary().total, 1);
})();

console.log('\n[4] 清零与缓存一致性');
(function () {
  var st = memStorage();
  var ledger = Ledger.create(st);
  ledger.record({ mode: 'local', result: resultOf(C.BLACK) });
  assert('清零前有账', ledger.summary().total, 1);
  ledger.reset();
  assert('清零后归零', ledger.summary().total, 0);
  assert('清零后比分行', ledger.line(), '松桂账本 · 待首局开枰');
  ledger._reload();
  assert('清零已写存储', ledger.summary().total, 0);
})();

console.log('\n----------------------------------------');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) {
  console.log('\x1b[31m账本测试未通过\x1b[0m\n');
  process.exit(1);
}
console.log('\x1b[32m账本全部测试通过\x1b[0m\n');
