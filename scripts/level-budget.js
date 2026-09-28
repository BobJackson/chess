/**
 * 档位预算诊断（node scripts/level-budget.js）
 *
 * 回答一个问题：**某一档在它自己的时限里，到底跑到几层、用掉多少预算**。
 *
 * 为什么需要它：`LEVELS` 的时限是当年按慢引擎定的。搜索优化（全排序 + LMR + 空着裁剪
 * + TT + PVS）之后引擎快了一个量级，实测各档只用掉预算的一小部分——**卡住强度的是
 * 深度上限，不是速度**，每个档都"算完了在干等"。2026-09-28 就是靠它发现大师档
 * 4500ms 预算只用了 1121ms，从而把上限从 8 层提到 10 层。
 *
 * 用法：
 *   node scripts/level-budget.js                 五档全测，各 25 局面
 *   node scripts/level-budget.js --level master --positions 40
 *   node scripts/level-budget.js --core /tmp/v-deep    测改过参数的版本
 *
 * 选项：
 *   --core DIR      核心目录（默认 ../miniprogram/core）
 *   --level KEY     只测某一档（beginner/easy/normal/hard/master；默认全测）
 *   --positions N   局面数（默认 25，含 5 个开局局面）
 *   --seed S        随机种子（默认 20260927）
 */

var CORE = require('path').join(__dirname, '..', 'miniprogram', 'core');
var ONLY = null, N = 25, SEED = 20260927;
(function () {
  var a = process.argv;
  for (var i = 0; i < a.length; i++) {
    if (a[i] === '--core') CORE = a[i + 1];
    else if (a[i] === '--level') ONLY = a[i + 1];
    else if (a[i] === '--positions') N = parseInt(a[i + 1], 10);
    else if (a[i] === '--seed') SEED = parseInt(a[i + 1], 10);
  }
})();

var Position = require(CORE + '/position.js');
var MG = require(CORE + '/movegen.js');
var AI = require(CORE + '/ai.js');

function makeRng(seed) {
  var t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    var r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

var fens = [];
var undo = { from: 0, to: 0, piece: 0, captured: 0, side: 0 };
[0, 2, 4, 6, 8].forEach(function (target, k) {
  var pos = new Position();
  for (var ply = 0; ply < target; ply++) {
    var legal = MG.genLegalMoves(pos, pos.side);
    var mv = legal[(k * 7 + ply * 13) % legal.length];
    pos.makeMove(MG.moveFrom(mv), MG.moveTo(mv), undo);
  }
  fens.push(pos.toFen());
});
var rng = makeRng(SEED), seen = {}, guard = 0;
while (fens.length < N + 5 && guard++ < N * 40) {
  var p = new Position();
  var t2 = 10 + ((rng() * 14) | 0);
  for (var q = 0; q < t2; q++) {
    var l2 = MG.genLegalMoves(p, p.side);
    if (!l2.length) break;
    var m2 = l2[(rng() * l2.length) | 0];
    p.makeMove(MG.moveFrom(m2), MG.moveTo(m2), undo);
  }
  if (MG.isChecked(p, p.side)) continue;
  var fen = p.toFen();
  var key = fen.split(' ')[0] + ' ' + fen.split(' ')[1];
  if (seen[key]) continue;
  seen[key] = 1; fens.push(fen);
}

console.log(CORE);
console.log('  ' + fens.length + ' 个局面（5 个开局 + ' + (fens.length - 5) + ' 个中局），各档用它自己的时限\n');
console.log('  档位   标称  时限      完成层数分布                中位用时  最大用时  撞上限');

var keys = ONLY ? [ONLY] : AI.LEVEL_ORDER;
keys.forEach(function (key) {
  var lv = AI.LEVELS[key];
  var dist = {}, times = [], capped = 0;
  fens.forEach(function (fen) {
    var r = AI.findBestMove(new Position(fen), { level: key, moveNumber: 999, useBook: false });
    dist[r.depth] = (dist[r.depth] || 0) + 1;
    times.push(r.time);
    if (r.depth >= lv.depth) capped++;
  });
  times.sort(function (a, b) { return a - b; });
  var ds = Object.keys(dist).sort(function (a, b) { return a - b; })
    .map(function (k) { return k + '层×' + dist[k]; }).join(' ');
  var name = lv.label;
  while (name.length < 6) name += ' ';
  console.log('  ' + name + ' ' + String(lv.depth).padStart(4) + '  ' +
    String(lv.time + 'ms').padEnd(9) + ' ' + ds.padEnd(28) + ' ' +
    String(times[Math.floor(times.length / 2)] + 'ms').padStart(8) + '  ' +
    String(times[times.length - 1] + 'ms').padStart(8) + '  ' +
    String(capped + '/' + fens.length).padStart(7));
});
console.log('\n  读法：中位用时远小于时限 = 预算没用完，强度被深度上限卡着，可以考虑抬上限。');
console.log('  "0 层"是入门/简单的失误随机（blunder）触发的随手棋，或开局库命中，属正常。');
console.log('  注：抬上限后记得跑 npm run bench:levels 与 npm run match -- --ladder 复核。');
