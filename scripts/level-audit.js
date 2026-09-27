/**
 * 难度档位强度审计（node scripts/level-audit.js）
 *
 * 回答"每一档到底弱多少"——比看层数直观，也比跑对局便宜：
 *   对每个局面，先用固定深度的**全窗口精确搜索**算出每一手棋的真实分值（基准），
 *   再让各档按自己的真实设置（失误概率 / 候选数 / 抖动 / 开局库）实际选一手，
 *   看它比"最优手"差多少分。差值（centipawn）就是这一档在那一手的"损失"。
 *
 * 用法：
 *   node scripts/level-audit.js                     默认 24 局面、每档每局面重复 3 次
 *   node scripts/level-audit.js --positions 40 --repeats 5
 *   node scripts/level-audit.js --base-depth 7      提高基准深度（更慢，但更接近真实最优）
 *
 * 选项：
 *   --positions N    局面数（默认 24，与对局脚本同一种子，可复现）
 *   --repeats N      每个局面每档重复几次（默认 3；低档有随机性，取平均）
 *   --base-depth N   基准搜索深度（默认 6，全窗口精确）
 *   --seed S         局面随机种子（默认 20260927）
 *
 * 注意：master 档每步最长 4.5s，24 局面 × 3 次 ≈ 5 分钟；降低 --repeats 可加速。
 */

var Position = require('../miniprogram/core/position.js');
var MG = require('../miniprogram/core/movegen.js');
var C = require('../miniprogram/core/constants.js');
var AI = require('../miniprogram/core/ai.js');

function parseArgs(argv) {
  var o = { positions: 24, repeats: 3, baseDepth: 6, seed: 20260927 };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--positions') o.positions = parseInt(argv[++i], 10);
    else if (a === '--repeats') o.repeats = parseInt(argv[++i], 10);
    else if (a === '--base-depth') o.baseDepth = parseInt(argv[++i], 10);
    else if (a === '--seed') o.seed = parseInt(argv[++i], 10);
  }
  return o;
}

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

/** 随机走 10~23 手取局面（与 match.js 同一种子逻辑，保证两边用同一批局面） */
function genPositions(rng, count) {
  var seen = {}, fens = [], guard = 0;
  while (fens.length < count && guard++ < count * 40) {
    var pos = new Position();
    var undo = { from: 0, to: 0, piece: 0, captured: 0, side: 0 };
    var target = 10 + ((rng() * 14) | 0);
    for (var ply = 0; ply < target; ply++) {
      var legal = MG.genLegalMoves(pos, pos.side);
      if (!legal.length) break;
      var mv = legal[(rng() * legal.length) | 0];
      pos.makeMove(MG.moveFrom(mv), MG.moveTo(mv), undo);
    }
    if (MG.isChecked(pos, pos.side)) continue;
    var fen = pos.toFen();
    var key = fen.split(' ')[0] + ' ' + fen.split(' ')[1];
    if (seen[key]) continue;
    seen[key] = 1;
    fens.push(fen);
  }
  return fens;
}

var o = parseArgs(process.argv.slice(2));
var FENS = genPositions(makeRng(o.seed), o.positions);

console.log('难度档位强度审计');
console.log('  ' + FENS.length + ' 个局面（随机走 10~23 手），基准 = 全窗口精确搜索 ' + o.baseDepth + ' 层');
console.log('  每档每局面实际选 ' + o.repeats + ' 次（含该档真实的失误概率/候选数/抖动）\n');

// 先把每个局面的"每手真实分值"算出来当基准
var baselines = FENS.map(function (fen) {
  var pos = new Position(fen);
  var scored = AI.analyzeMoves(pos, o.baseDepth, true);
  var map = {};
  scored.forEach(function (s) { map[s.move] = s.score; });
  return { fen: fen, best: scored.length ? scored[0].score : 0, map: map, n: scored.length };
});

var rows = [];
AI.LEVEL_ORDER.forEach(function (key) {
  var lv = AI.LEVELS[key];
  var losses = [], blunders = 0, total = 0;
  baselines.forEach(function (b) {
    var pos0 = new Position(b.fen);
    for (var r = 0; r < o.repeats; r++) {
      var pos = new Position(b.fen);
      // moveNumber 给大值：关掉"开局变化"随机化（这些是中局局面），但保留该档的
      // 失误概率、候选数 topN 与抖动 noise——那才是它在产品里的真实行为。
      var res = AI.findBestMove(pos, { level: key, moveNumber: 99 });
      if (!res || b.map[res.move] === undefined) continue;
      var loss = b.best - b.map[res.move];
      losses.push(loss);
      total++;
      if (loss >= 200) blunders++;
    }
  });
  losses.sort(function (a, b) { return a - b; });
  var sum = 0;
  losses.forEach(function (v) { sum += v; });
  var avg = total ? sum / total : 0;
  var med = total ? losses[Math.floor(total / 2)] : 0;
  rows.push({
    key: key, label: lv.label, depth: lv.depth, time: lv.time,
    exact: lv.exact ? '全窗口' : '窄窗口',
    noise: lv.noise, topN: lv.topN, blunder: lv.blunder,
    avg: avg, med: med, blunderRate: total ? blunders / total : 0, n: total
  });
});

console.log('  档位   深度  窗口      抖动  候选  失误率   平均损失   中位损失   大漏着率');
rows.forEach(function (r) {
  var name = r.label;
  while (name.length < 6) name += ' ';
  console.log('  ' + name + ' ' + String('d' + r.depth).padEnd(5) + ' ' +
    String(r.exact).padEnd(8) + ' ' + String(r.noise).padEnd(5) + ' ' +
    String(r.topN).padEnd(5) + ' ' + String(r.blunder).padEnd(8) + ' ' +
    String(Math.round(r.avg)).padStart(8) + '   ' + String(Math.round(r.med)).padStart(8) +
    '   ' + String(Math.round(r.blunderRate * 100) + '%').padStart(8));
});
console.log('\n  平均损失 = 实际选中手比"最优手"差多少分（百分之一子），越大越弱');
console.log('  大漏着率 = 单步损失 ≥ 200（两个兵）的比例');
console.log('  注：master 的深度(8)高于基准(' + o.baseDepth + ')，它的损失会被高估（偶尔为负）；看排序即可。');
