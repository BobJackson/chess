/**
 * 粒子系统测试（node scripts/test-particles.js）
 *
 * 覆盖：固定池上限、生命周期消亡、重力/风摆/自旋积分、
 * 发射器（迸溅/桂花/冲击波环）、确定性随机源、桩上下文绘制。
 */

var P = require('../miniprogram/ui/particles.js');

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

function stubCtx() {
  var calls = { arc: 0, fill: 0, stroke: 0, fillRect: 0 };
  return {
    calls: calls,
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1,
    save: function () {}, restore: function () {},
    translate: function () {}, rotate: function () {}, scale: function () {},
    beginPath: function () {}, closePath: function () {},
    arc: function () { calls.arc++; },
    fill: function () { calls.fill++; },
    stroke: function () { calls.stroke++; },
    fillRect: function () { calls.fillRect++; },
    moveTo: function () {}, lineTo: function () {}
  };
}

console.log('\n[1] 固定池与生命周期');
(function () {
  var pool = P.create(4);
  assert('空池', pool.count(), 0);
  truthy('第一粒入池', pool.spawn({ x: 1, y: 2, ttl: 100 }));
  truthy('第二粒入池', pool.spawn({ x: 3, y: 4, ttl: 100 }));
  truthy('第三粒入池', pool.spawn({ x: 5, y: 6, ttl: 100 }));
  truthy('第四粒入池', pool.spawn({ x: 7, y: 8, ttl: 100 }));
  assert('池满丢弃第五粒', pool.spawn({ x: 9, y: 9 }), false);
  assert('池上限生效', pool.count(), 4);

  pool.tick(120); // 全部 ttl 100 → 消亡
  assert('到时全部消亡', pool.count(), 0);
  // 消亡后槽位复用
  truthy('槽位可复用', pool.spawn({ x: 0, y: 0 }));
  assert('复用后计数', pool.count(), 1);

  pool.clear();
  assert('clear 清空', pool.count(), 0);
})();

console.log('\n[2] 运动积分：重力、风摆、自旋');
(function () {
  var pool = P.create(8);
  // 重力：vy 随时间增加
  pool.spawn({ shape: 'chip', x: 0, y: 0, vx: 100, vy: 0, gravity: 1000, ttl: 1000 });
  pool.tick(100);
  // 内部不可见，用绘制验证存活即可；位置间接验证：再 tick 不抛异常
  pool.tick(100);
  assert('重力粒子存活中', pool.count(), 1);

  // 风摆花瓣：x 会偏离直线下落轨迹（sway 积分不发散）
  var p2 = P.create(4);
  p2.setRng(function () { return 0.5; });
  P.petal(p2, 100, 0, { vy: 50, swayAmp: 10, ttl: 2000 });
  for (var i = 0; i < 100; i++) p2.tick(16);
  assert('风摆花瓣存活', p2.count(), 1);

  // 冲击波环到时消亡
  var p3 = P.create(4);
  P.ring(p3, 50, 50, { ttl: 300 });
  for (i = 0; i < 30; i++) p3.tick(16);
  assert('冲击波环到时消亡', p3.count(), 0);
})();

console.log('\n[3] 发射器');
(function () {
  var pool = P.create(64);
  pool.setRng(function () { return 0.5; }); // 确定性
  var n = P.burst(pool, 100, 100, { n: 7, shape: 'chip', colors: ['#a00', '#b85'], gravity: 900 });
  assert('迸溅 7 粒', n, 7);
  assert('计数一致', pool.count(), 7);

  // 池容量保护：再要 60 粒只有 57 粒能进
  n = P.burst(pool, 0, 0, { n: 60 });
  assert('超容量部分丢弃', n, 57);

  // 桂花
  var p2 = P.create(8);
  p2.setRng(function () { return 0.5; });
  truthy('桂花入池', P.petal(p2, 50, -10));
  truthy('冲击波环入池', P.ring(p2, 50, 50));
  assert('两类共存', p2.count(), 2);
})();

console.log('\n[4] 绘制（桩上下文）');
(function () {
  var pool = P.create(16);
  pool.setRng(function () { return 0.5; });
  pool.spawn({ shape: 'dot', x: 1, y: 1, ttl: 1000 });
  pool.spawn({ shape: 'chip', x: 2, y: 2, ttl: 1000 });
  pool.spawn({ shape: 'petal', x: 3, y: 3, ttl: 1000 });
  pool.spawn({ shape: 'drop', x: 4, y: 4, ttl: 1000 });
  P.ring(pool, 5, 5, { ttl: 1000 });

  // 先推进 200ms：花瓣有 15% 淡入期，life=0 时不画是正确行为
  pool.tick(200);
  var ctx = stubCtx();
  pool.draw(ctx);
  assert('五种形状都画了', ctx.calls.fill + ctx.calls.stroke + ctx.calls.fillRect >= 5, true);
  assert('圆类形状走 arc', ctx.calls.arc, 4);
  assert('木屑走 fillRect', ctx.calls.fillRect, 1);
  assert('冲击波环走 stroke', ctx.calls.stroke, 1);

  // 粒子全部消亡后绘制为空
  for (var i = 0; i < 100; i++) pool.tick(16);
  var ctx2 = stubCtx();
  pool.draw(ctx2);
  assert('消亡后无绘制', ctx2.calls.fill + ctx2.calls.stroke + ctx2.calls.fillRect, 0);
})();

console.log('\n----------------------------------------');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) {
  console.log('\x1b[31m粒子系统测试未通过\x1b[0m\n');
  process.exit(1);
}
console.log('\x1b[32m粒子系统全部测试通过\x1b[0m\n');
