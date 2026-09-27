/**
 * 确定性多局面对抗（node scripts/match.js）
 *
 * 为什么需要它：早先用"等时对抗（产品路径 createSearch，1500ms/步，8 局）"评估改动，
 * 样本太小——**同引擎自对弈都能打出 4 胜 1 和 3 负**，小幅改动（净 ±10 以内）根本
 * 读不出来。这个脚本换成确定性对抗：在固定局面套件上、固定深度、关闭一切随机化
 * 对弈，正反两色各一局，结果完全可复现，同引擎对照恒为净 0。
 *
 * 用法：
 *   node scripts/match.js --save /tmp/before   把当前 core 存一份，作为对照
 *   node scripts/match.js /tmp/before          当前 vs 对照（默认深度 5、59 局面、固定种子）
 *
 * 选项：
 *   --depth N       固定搜索深度（默认 5；越深越慢，深度 6 约 2.5 倍）
 *   --positions N   局面套件大小（默认 59，即 118 局）
 *   --seed S        局面生成的随机种子（默认 20260927，保证可复现）
 *
 * 判读：同引擎对照净 0；净 ≥ 10 视为有信号，净 < 10 视为持平。子力差 ≥ 120 才算
 * 分胜负（手数上限内），否则判和——所以"净"是胜负局之差。
 */

var fs = require('fs');
var path = require('path');
var Position = require('../miniprogram/core/position.js');
var MG = require('../miniprogram/core/movegen.js');
var C = require('../miniprogram/core/constants.js');
var EV = require('../miniprogram/core/evaluate.js');

var CORE = path.join(__dirname, '..', 'miniprogram', 'core');
var CORE_FILES = ['ai.js', 'constants.js', 'movegen.js', 'position.js', 'evaluate.js',
  'book.js', 'mate.js', 'notation.js', 'game.js', 'ledger.js'];

function parseArgs(argv) {
  var o = { save: null, control: null, depth: 5, positions: 59, seed: 20260927 };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--save') o.save = argv[++i];
    else if (a === '--depth') o.depth = parseInt(argv[++i], 10);
    else if (a === '--positions') o.positions = parseInt(argv[++i], 10);
    else if (a === '--seed') o.seed = parseInt(argv[++i], 10);
    else if (a.charAt(0) !== '-') o.control = a;
  }
  return o;
}

/** 可复现的伪随机数（mulberry32） */
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

/** 从初始局面随机走 10~23 手，取互不相同、且走子方不被将的局面 */
function genPositions(rng, count) {
  var seen = {};
  var fens = [];
  var guard = 0;
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

/** 红方视角子力差（不含将帅） */
function material(pos) {
  var s = 0;
  for (var i = 0; i < C.BOARD_SIZE; i++) {
    var p = pos.board[i];
    if (p === C.EMPTY) continue;
    var t = p > 0 ? p : -p;
    if (t === 1) continue;
    s += p > 0 ? EV.PIECE_VALUE[t] : -EV.PIECE_VALUE[t];
  }
  return s;
}

var PLY_CAP = 80;
var WIN_MARGIN = 120;

/** aIsRed=true 表示 A 执红。返回 'A' | 'B' | 'draw' */
function play(A, B, fen, aIsRed, depth) {
  var pos = new Position(fen);
  var undo = { from: 0, to: 0, piece: 0, captured: 0, side: 0 };
  var sigs = {};
  var ply = 0;
  var reason = '手数上限';
  while (ply < PLY_CAP) {
    var legal = MG.genLegalMoves(pos, pos.side);
    if (!legal.length) { reason = '无子可动'; break; }
    var sig = pos.signature();
    sigs[sig] = (sigs[sig] || 0) + 1;
    if (sigs[sig] >= 3) { reason = '三次重复'; break; }
    var eng = ((pos.side === C.RED) === aIsRed) ? A : B;
    var r = eng.findBestMove(pos, {
      level: 'master', depth: depth, deterministic: true, useBook: false, moveNumber: 999
    });
    if (!r) { reason = '异常'; break; }
    pos.makeMove(MG.moveFrom(r.move), MG.moveTo(r.move), undo);
    ply++;
  }
  // 无子可动：走子方判负（象棋困毙算输）
  if (reason === '无子可动') return ((pos.side === C.RED) === aIsRed) ? 'B' : 'A';
  if (reason === '三次重复') return 'draw';
  var m = material(pos);
  if (m >= WIN_MARGIN) return aIsRed ? 'A' : 'B';
  if (m <= -WIN_MARGIN) return aIsRed ? 'B' : 'A';
  return 'draw';
}

function main() {
  var o = parseArgs(process.argv.slice(2));

  if (o.save) {
    fs.mkdirSync(o.save, { recursive: true });
    CORE_FILES.forEach(function (f) {
      fs.copyFileSync(path.join(CORE, f), path.join(o.save, f));
    });
    console.log('已把当前 core 存到 ' + o.save + '（' + CORE_FILES.length + ' 个文件）');
    console.log('接下来：改代码 → node scripts/match.js ' + o.save);
    return;
  }

  if (!o.control) {
    console.log('用法：node scripts/match.js <对照核心目录>   或   node scripts/match.js --save <目录>');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(o.control, 'ai.js'))) {
    console.log('对照目录里没有 ai.js：' + o.control);
    process.exit(1);
  }

  var A = require(path.join(CORE, 'ai.js'));
  var B = require(path.join(o.control, 'ai.js'));

  var fens = genPositions(makeRng(o.seed), o.positions);
  var aWin = 0, bWin = 0, draw = 0;
  fens.forEach(function (fen) {
    [true, false].forEach(function (aIsRed) {
      var res = play(A, B, fen, aIsRed, o.depth);
      if (res === 'A') aWin++;
      else if (res === 'B') bWin++;
      else draw++;
    });
  });

  console.log('确定性多局面对抗：当前 vs ' + o.control);
  console.log('  固定深度 ' + o.depth + '，无随机化，' + fens.length + ' 局面 × 正反两色 = ' + (fens.length * 2) + ' 局');
  console.log('  当前 ' + aWin + ' 胜 ' + draw + ' 和 ' + bWin + ' 负  →  净 ' + (aWin - bWin));
  console.log('  （同引擎对照恒为净 0；净 ≥ 10 才算有信号，净 < 10 视为持平）');
}

main();
