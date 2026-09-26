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
  // 本地双人「让先执黑」（设置页选边）：松执黑，黑胜记松（缺省 humanSide 仍兼容旧口径红=松）
  assert('本地松执黑时黑胜记松', Ledger.outcomeFor('local', resultOf(C.BLACK), C.BLACK), 'song');
  assert('本地松执黑时红胜记桂', Ledger.outcomeFor('local', resultOf(C.RED), C.BLACK), 'gui');
  assert('本地松执黑时和棋', Ledger.outcomeFor('local', resultOf(-1), C.BLACK), 'draw');
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

console.log('\n[2.5] 逐局历史与连胜');
(function () {
  var st = memStorage();
  var l = Ledger.create(st);

  function rec(mode, winner, when) {
    l.record({ mode: mode, result: resultOf(winner, '测试终局'), humanSide: C.RED, when: when });
  }

  assert('空账无历史', l.history().length, 0);
  assert('空账无连胜', l.streak(), null);

  rec('local', C.RED, 1000);   // 松
  rec('local', -1, 2000);      // 和
  rec('online', C.RED, 3000);  // 松
  assert('历史按时间序（最旧在前）', l.history().length, 3);
  assert('历史条目字段', (function () {
    var g = l.history()[0];
    return g.t + ',' + g.mode + ',' + g.outcome + ',' + g.text;
  })(), '1000,local,song,测试终局');
  assert('一胜不算连胜', l.streak(), null);

  rec('online', C.RED, 4000);  // 松
  var s1 = l.streak();
  assert('两连胜成立', s1 ? s1.who + s1.n : '', 'song2');

  rec('local', C.BLACK, 5000); // 桂（local 缺省红=松，黑胜记桂）
  assert('被终结后无连胜', l.streak(), null);
  rec('local', C.BLACK, 6000); // 桂
  var s2 = l.streak();
  assert('桂两连胜', s2 ? s2.who + s2.n : '', 'gui2');

  rec('local', -1, 7000);      // 和棋断连
  assert('和棋断连胜', l.streak(), null);

  // 上限：记满 MAX_GAMES+5 局，历史截到上限且保留最新
  for (var i = 0; i < Ledger.MAX_GAMES + 5; i++) rec('local', C.RED, 10000 + i);
  assert('历史截到上限', l.history().length, Ledger.MAX_GAMES);
  var last = l.history()[l.history().length - 1];
  assert('上限截断保留最新', last.t, 10000 + Ledger.MAX_GAMES + 4);
})();

console.log('\n[2.6] 旧账数据兼容（无 games 字段）');
(function () {
  var st = memStorage();
  // 模拟 v1.0.8 时代的旧账：只有计数与 last
  st.data['songgui-ledger-v1'] = { v: 1, total: 3, song: 2, gui: 1, draws: 0,
    last: { t: 1000, mode: 'local', outcome: 'song', text: '旧局' } };
  var l = Ledger.create(st);
  assert('旧账计数保留', l.summary().total, 3);
  assert('旧账历史为空', l.history().length, 0);
  l.record({ mode: 'local', result: resultOf(C.RED), when: 2000 });
  assert('旧账续记后历史从 1 开始', l.history().length, 1);
  assert('旧账计数续增', l.summary().total, 4);
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
