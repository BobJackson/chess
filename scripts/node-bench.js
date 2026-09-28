/**
 * 评估项节点代价基准（node scripts/node-bench.js）
 *
 * 用途：改动评估函数后，看它在**整批局面**上到底多花/少花多少节点。
 *
 * **为什么必须用一批局面而不是一个局面**：2026-09-28 踩过的坑——拿单个初始局面
 * 测"将帅威胁项"，得出"减半省 24% 节点"；换成 50 个局面的套件重测，差别只有 ±3%，
 * 而且方向还反过来。单个局面的节点数受 alpha-beta 剪枝的混沌影响，不能当结论。
 *
 * **套件里必须有开局局面**：评估项（机动性、将帅威胁这类"多子参与"的项）的量级效应
 * 在开局最明显（32 个子都在场上），只用中局局面测会得出"没差别"的错误结论。
 *
 * 用法：
 *   node scripts/node-bench.js                       当前 core，深度 6
 *   node scripts/node-bench.js --core /tmp/v-xxx     指定目录
 *   node scripts/node-bench.js --depth 8             指定深度
 *
 * 选项：
 *   --core DIR    核心目录（默认 ../miniprogram/core）
 *   --depth N     搜索深度（默认 6）
 *   --random N    随机中局局面数（默认 45；外加固定的 5 个开局局面）
 *   --seed S      随机种子（默认 20260927）
 */

var CORE = require('path').join(__dirname, '..', 'miniprogram', 'core');
var DEPTH = 6, RANDOM = 45, SEED = 20260927;
(function () {
  var a = process.argv;
  for (var i = 0; i < a.length; i++) {
    if (a[i] === '--core') CORE = a[i + 1];
    else if (a[i] === '--depth') DEPTH = parseInt(a[i + 1], 10);
    else if (a[i] === '--random') RANDOM = parseInt(a[i + 1], 10);
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

// 开局前几手：0/2/4/6/8 手，走法固定以便复现
[0, 2, 4, 6, 8].forEach(function (target, k) {
  var pos = new Position();
  for (var ply = 0; ply < target; ply++) {
    var legal = MG.genLegalMoves(pos, pos.side);
    var mv = legal[(k * 7 + ply * 13) % legal.length];
    pos.makeMove(MG.moveFrom(mv), MG.moveTo(mv), undo);
  }
  fens.push(pos.toFen());
});

// 随机中局局面
var rng = makeRng(SEED);
var seen = {}, guard = 0;
while (fens.length < RANDOM + 5 && guard++ < RANDOM * 40) {
  var p2 = new Position();
  var target2 = 10 + ((rng() * 14) | 0);
  for (var ply2 = 0; ply2 < target2; ply2++) {
    var legal2 = MG.genLegalMoves(p2, p2.side);
    if (!legal2.length) break;
    var mv2 = legal2[(rng() * legal2.length) | 0];
    p2.makeMove(MG.moveFrom(mv2), MG.moveTo(mv2), undo);
  }
  if (MG.isChecked(p2, p2.side)) continue;
  var fen = p2.toFen();
  var key = fen.split(' ')[0] + ' ' + fen.split(' ')[1];
  if (seen[key]) continue;
  seen[key] = 1; fens.push(fen);
}

var total = 0, t0 = Date.now();
fens.forEach(function (fen) {
  var r = AI.findBestMove(new Position(fen), {
    level: 'master', depth: DEPTH, deterministic: true, useBook: false, moveNumber: 999
  });
  total += r.nodes;
});
console.log(CORE);
console.log('  深度 ' + DEPTH + '，' + fens.length + ' 个局面（5 个开局 + ' + (fens.length - 5) + ' 个中局）');
console.log('  总节点 ' + (total / 1e6).toFixed(2) + 'M，耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
console.log('  注：单局面差异不可信，要比就比同一批局面的总数。');
