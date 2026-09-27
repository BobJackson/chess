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
 *   node scripts/match.js --ladder             难度阶梯：相邻档两两对抗（只差深度/窗口）
 *
 * 选项：
 *   --depth N       固定搜索深度（默认 5；越深越慢，深度 6 约 2.5 倍）
 *                  也可以写 A:B（如 --depth 7:6），给两边不同深度——用来做
 *                  "等时补偿"：速度快的版本多算一层，看它是否仍不落下风。
 *   --level A:B     两边各用哪个难度档（如 --level beginner:easy）。给了 --level 又没给
 *                  --depth 时，用各档自带的深度与窗口（确定性模式会跳过失误随机与开局库，
 *                  所以这时测的就是纯粹的"深度阶梯"）。
 *   --ladder        难度阶梯：相邻档两两对抗（同一份引擎，只差档位参数）。
 *   --self-control  阶梯模式下，每对先跑一次同档自对照（结果翻倍耗时，仅用于校准）。
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
  var o = {
    save: null, control: null, ladder: false, selfControl: false,
    depthA: null, depthB: null,
    levelA: 'master', levelB: 'master',
    positions: 59, seed: 20260927
  };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--save') o.save = argv[++i];
    else if (a === '--ladder') o.ladder = true;
    else if (a === '--self-control') o.selfControl = true;
    else if (a === '--depth') {
      var d = String(argv[++i]);
      if (d.indexOf(':') >= 0) {
        o.depthA = parseInt(d.split(':')[0], 10);
        o.depthB = parseInt(d.split(':')[1], 10);
      } else {
        o.depthA = o.depthB = parseInt(d, 10);
      }
    }
    else if (a === '--level') {
      var lv = String(argv[++i]).split(':');
      o.levelA = lv[0];
      o.levelB = lv.length > 1 ? lv[1] : lv[0];
    }
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

/** aIsRed=true 表示 A 执红。cfg = { level, depth }（depth 为 null 时用该档自带深度） */
function play(A, B, fen, aIsRed, cfgA, cfgB) {
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
    var aToMove = (pos.side === C.RED) === aIsRed;
    var eng = aToMove ? A : B;
    var cfg = aToMove ? cfgA : cfgB;
    var opt = { level: cfg.level, deterministic: true, useBook: false, moveNumber: 999 };
    if (cfg.depth) opt.depth = cfg.depth;
    var r = eng.findBestMove(pos, opt);
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

  var A = require(path.join(CORE, 'ai.js'));

  // ---- 难度阶梯：相邻档两两对抗（同一份引擎，只差档位参数）----
  if (o.ladder) {
    var order = A.LEVEL_ORDER;
    var fensL = genPositions(makeRng(o.seed), o.positions);
    console.log('难度阶梯（确定性：跳过失误随机与开局库，只差深度与窗口）');
    console.log('  ' + fensL.length + ' 局面 × 正反两色 = ' + (fensL.length * 2) + ' 局/对');
    if (o.selfControl) console.log('  每对先跑一次同档自对照，确认基准为净 0');
    console.log('');
    for (var i = 1; i < order.length; i++) {
      var hi = order[i], lo = order[i - 1];
      var ctrlText = '';
      if (o.selfControl) {
        // 自对照：上档 vs 上档，应为净 0
        var cw = 0, cl = 0, cd = 0;
        fensL.forEach(function (fen) {
          [true, false].forEach(function (hiIsRed) {
            var rc = play(A, A, fen, hiIsRed, { level: hi, depth: o.depthA }, { level: hi, depth: o.depthA });
            if (rc === 'draw') cd++; else if (rc === 'A') cw++; else cl++;
          });
        });
        ctrlText = '   [自对照 ' + (cw - cl) + ']';
      }
      var hw = 0, lw = 0, dr = 0;
      fensL.forEach(function (fen) {
        [true, false].forEach(function (hiIsRed) {
          // 第一个参数是"上档"，play 返回 'A' 即上档胜（与执红执黑无关）
          var res = play(A, A, fen, hiIsRed,
            { level: hi, depth: o.depthA }, { level: lo, depth: o.depthB });
          if (res === 'draw') dr++; else if (res === 'A') hw++; else lw++;
        });
      });
      var lv = A.LEVELS[lo], hv = A.LEVELS[hi];
      var name = hv.label + '(d' + hv.depth + ') vs ' + lv.label + '(d' + lv.depth + ')';
      while (name.length < 22) name += ' ';
      console.log('  ' + name + '净 ' + String(hw - lw).padStart(4) +
        '   ' + hw + '胜/' + dr + '和/' + lw + '负' + ctrlText);
    }
    return;
  }

  if (!o.control) {
    console.log('用法：node scripts/match.js <对照核心目录>');
    console.log('      node scripts/match.js --save <目录>');
    console.log('      node scripts/match.js --ladder        难度阶梯：相邻档两两对抗');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(o.control, 'ai.js'))) {
    console.log('对照目录里没有 ai.js：' + o.control);
    process.exit(1);
  }

  var B = require(path.join(o.control, 'ai.js'));
  var cfgA = { level: o.levelA, depth: o.depthA };
  var cfgB = { level: o.levelB, depth: o.depthB };

  var fens = genPositions(makeRng(o.seed), o.positions);
  var aWin = 0, bWin = 0, draw = 0;
  fens.forEach(function (fen) {
    [true, false].forEach(function (aIsRed) {
      var res = play(A, B, fen, aIsRed, cfgA, cfgB);
      if (res === 'A') aWin++;
      else if (res === 'B') bWin++;
      else draw++;
    });
  });

  function cfgText(cfg) {
    var d = cfg.depth || A.LEVELS[cfg.level].depth;
    return cfg.level + '(d' + d + ')';
  }
  console.log('确定性多局面对抗：当前 vs ' + o.control);
  console.log('  当前 ' + cfgText(cfgA) + ' / 对照 ' + cfgText(cfgB) +
    '，无随机化，' + fens.length + ' 局面 × 正反两色 = ' + (fens.length * 2) + ' 局');
  console.log('  当前 ' + aWin + ' 胜 ' + draw + ' 和 ' + bWin + ' 负  →  净 ' + (aWin - bWin));
  console.log('  （同引擎对照恒为净 0；净 ≥ 10 才算有信号，净 < 10 视为持平）');
}

main();
