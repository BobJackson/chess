/**
 * 开局库审计（node scripts/book-audit.js）
 *
 * 两件事：
 *   A. 库着质量：沿每条线路走，每一手都拿**全窗口精确搜索**算出该手与"引擎自己会选的
 *      最好手"差多少分。差值大说明这一手在库里有问题（要么线路本身不成立，要么就是
 *      引擎的开局评估不准——后者正是开局库存在的理由，所以只看大数）。
 *   B. 开局多样性：按权重反复抽样，看首手分布与前 N 手序列的种类数。
 *
 * 用法：
 *   node scripts/book-audit.js                    默认深度 6、多样性抽样 400 次
 *   node scripts/book-audit.js --depth 5 --samples 800
 *
 * 选项：
 *   --depth N     精确搜索深度（默认 6）
 *   --samples N   多样性抽样次数（默认 400）
 *   --top N       线路质量表只打印损失最大的前 N 条（默认全部）
 *   --core DIR    用指定核心目录（默认 ../miniprogram/core）——拿旧库做对照时用
 */

var CORE = require('path').join(__dirname, '..', 'miniprogram', 'core');
(function () {
  var argv = process.argv;
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === '--core') CORE = argv[i + 1];
  }
})();

var Position = require(CORE + '/position.js');
var MG = require(CORE + '/movegen.js');
var C = require(CORE + '/constants.js');
var AI = require(CORE + '/ai.js');
var NT = require(CORE + '/notation.js');
var BOOK = require(CORE + '/book.js');

function parseArgs(argv) {
  var o = { depth: 6, samples: 400, top: 0, flag: 150 };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--depth') o.depth = parseInt(argv[++i], 10);
    else if (a === '--samples') o.samples = parseInt(argv[++i], 10);
    else if (a === '--top') o.top = parseInt(argv[++i], 10);
    else if (a === '--flag') o.flag = parseInt(argv[++i], 10);
  }
  return o;
}

var o = parseArgs(process.argv.slice(2));
var undo = { from: 0, to: 0, piece: 0, captured: 0, side: 0 };

// ---------------------------------------------------------------------------
// A. 库着质量
// ---------------------------------------------------------------------------
console.log('A. 库着质量（每手与"引擎全窗口精确搜索 ' + o.depth + ' 层"的最好手差多少分）\n');
console.log('  线路  手数  最大损失  平均损失  终点红方视角  最差的一手');

var rows = [];
var allLoss = [];
BOOK.BOOK_LINES.forEach(function (line, idx) {
  var pos = new Position();
  var losses = [];
  var worst = null;
  var ok = true;
  for (var i = 0; i < line.moves.length; i++) {
    var scored = AI.analyzeMoves(pos, o.depth, true);
    var map = {};
    scored.forEach(function (s) { map[s.move] = s.score; });
    var mv = BOOK.parseMove(line.moves[i]);
    if (mv === null || map[mv] === undefined) { ok = false; break; }
    var loss = scored[0].score - map[mv];
    losses.push(loss);
    if (!worst || loss > worst.loss) {
      worst = {
        loss: loss, i: i,
        text: NT.moveText(pos, MG.moveFrom(mv), MG.moveTo(mv)),
        bestText: NT.moveText(pos, MG.moveFrom(scored[0].move), MG.moveTo(scored[0].move)),
        score: map[mv], best: scored[0].score
      };
    }
    pos.makeMove(MG.moveFrom(mv), MG.moveTo(mv), undo);
  }
  if (!ok) { console.log('  ' + String(idx).padStart(3) + '  解析失败'); return; }
  var end = AI.analyzeMoves(pos, o.depth, true);
  var v = end.length ? end[0].score : 0;
  var redView = pos.side === C.RED ? v : -v;
  var maxLoss = Math.max.apply(null, losses);
  var sum = 0;
  losses.forEach(function (x) { sum += x; allLoss.push(x); });
  rows.push({
    idx: idx, n: line.moves.length, max: maxLoss, avg: sum / losses.length,
    red: redView, w: line.w, worst: worst
  });
});

rows.sort(function (a, b) { return b.max - a.max; });
var show = o.top > 0 ? rows.slice(0, o.top) : rows;
show.forEach(function (r) {
  console.log('  ' + String(r.idx).padStart(3) + '   ' + String(r.n).padStart(3) +
    '   ' + String(r.max).padStart(6) + '   ' + String(Math.round(r.avg)).padStart(7) +
    '   ' + String(r.red).padStart(10) + '   ' +
    (r.max >= o.flag ? '第' + (r.worst.i + 1) + '手 ' + r.worst.text +
      '（该手 ' + r.worst.score + '，最好手 ' + r.worst.bestText + ' ' + r.worst.best + '）' : ''));
});

allLoss.sort(function (a, b) { return a - b; });
var sum = 0;
allLoss.forEach(function (x) { sum += x; });
console.log('\n  全部 ' + allLoss.length + ' 手：中位损失 ' + allLoss[Math.floor(allLoss.length / 2)] +
  '，平均 ' + Math.round(sum / allLoss.length) +
  '，最大 ' + allLoss[allLoss.length - 1] +
  '，损失 ≥200 的手数 ' + allLoss.filter(function (x) { return x >= 200; }).length);
console.log('  注：库着比引擎自己的选择差，未必是库的错——引擎的开局评估本来就不准，');
console.log('      这正是开局库存在的理由。这里只用来抓"明显不成立"的线路。');

// ---------------------------------------------------------------------------
// B. 开局多样性
// ---------------------------------------------------------------------------
console.log('\n\nB. 开局多样性（按权重抽样 ' + o.samples + ' 次）\n');
var firstCount = {};
var seqSets = {};
[2, 3, 4, 5, 6, 7].forEach(function (L) { seqSets[L] = {}; });
for (var n = 0; n < o.samples; n++) {
  var pos = new Position();
  var seq = [];
  for (var ply = 0; ply < 7; ply++) {
    var bm = BOOK.getBookMove(pos);
    if (bm === null) break;
    if (ply === 0) firstCount[bm] = (firstCount[bm] || 0) + 1;
    seq.push(bm);
    pos.makeMove(MG.moveFrom(bm), MG.moveTo(bm), undo);
    if (seqSets[seq.length]) seqSets[seq.length][seq.join(',')] = 1;
  }
}
var fk = Object.keys(firstCount).sort(function (a, b) { return firstCount[b] - firstCount[a]; });
var top = firstCount[fk[0]];
console.log('  首手种类 ' + fk.length + ' 种，最常见占 ' +
  Math.round(top / o.samples * 100) + '%');
console.log('  各长度序列种类：' + [2, 3, 4, 5, 6, 7].map(function (L) {
  return L + '手 ' + Object.keys(seqSets[L]).length;
}).join(' / ') + '（抽样 ' + o.samples + ' 次）');
console.log('  首手分布：');
fk.forEach(function (k) {
  console.log('    ' + String(Math.round(firstCount[k] / o.samples * 100) + '%').padStart(5) +
    '   ' + NT.moveText(new Position(), MG.moveFrom(k), MG.moveTo(k)));
});
