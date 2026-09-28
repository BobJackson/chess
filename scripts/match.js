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
 *   --suites N      跑 N 套**不同种子的局面**并汇总（子进程并行）。
 *                   **判定评估类改动必须用它**：单一局面套件的结果受局面抽样偏差影响，
 *                   同一对照换套局面结论可能变号（2026-09-28 实测 LMR 那条 +2 → −5）。
 *                   判读看"是否全部同号"，有正有负就说明效应落在偏差之下。
 *   --json          只输出一行 JSON（供 --suites 的子进程用，一般不用手调）
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
    save: null, control: null, ladder: false, selfControl: false, json: false,
    depthA: null, depthB: null,
    levelA: 'master', levelB: 'master',
    positions: 59, endgame: 0, seed: 20260927, suites: 1
  };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--save') o.save = argv[++i];
    else if (a === '--ladder') o.ladder = true;
    else if (a === '--self-control') o.selfControl = true;
    else if (a === '--json') o.json = true;
    else if (a === '--suites') o.suites = parseInt(argv[++i], 10);
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
    else if (a === '--endgame') o.endgame = parseInt(argv[++i], 10);
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

// 初始布局（每格一个字符，'' 为空），用于"按类型成对删子"构造残局
var INIT_GRID = [
  ['r', 'n', 'b', 'a', 'k', 'a', 'b', 'n', 'r'],
  ['', '', '', '', '', '', '', '', ''],
  ['', 'c', '', '', '', '', '', 'c', ''],
  ['p', '', 'p', '', 'p', '', 'p', '', 'p'],
  ['', '', '', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', '', ''],
  ['P', '', 'P', '', 'P', '', 'P', '', 'P'],
  ['', 'C', '', '', '', '', '', 'C', ''],
  ['', '', '', '', '', '', '', '', ''],
  ['R', 'N', 'B', 'A', 'K', 'A', 'B', 'N', 'R']
];

/** 把 10×9 字符网格编成 FEN（红先） */
function gridToFen(grid) {
  var rows = [];
  for (var r = 0; r < 10; r++) {
    var s = '', empty = 0;
    for (var f = 0; f < 9; f++) {
      var c = grid[r][f];
      if (!c) { empty++; continue; }
      if (empty) { s += empty; empty = 0; }
      s += c;
    }
    if (empty) s += empty;
    rows.push(s);
  }
  return rows.join('/') + ' w - - 0 1';
}

/**
 * 残局局面：**从初始布局按类型成对删子**（双方保留同样数量 → 天然均势）。
 *
 * 为什么不用"随机走很多手"：纯随机走几乎不减子力（实测 3000 次全 > 3500）；改成
 * "优先吃子"又会一路换到底，把车马炮全换光（只剩士象兵）——那样**马炮残局调整照样
 * 走不到**。删子法既能控子力总量，又能保证留下攻子。
 */
function genEndgameFens(rng, count) {
  var out = [];
  var seen = {};
  var guard = 0;
  while (out.length < count && guard++ < count * 400) {
    var keepR = (rng() * 3) | 0, keepN = (rng() * 3) | 0, keepC = (rng() * 3) | 0;
    var keepA = (rng() * 3) | 0, keepB = (rng() * 3) | 0, keepP = (rng() * 6) | 0;
    var perSide = keepR * 900 + keepN * 400 + keepC * 450 + keepA * 200 + keepB * 200 + keepP * 70;
    var total = perSide * 2;
    if (total < 500 || total >= EV.ENDGAME_MATERIAL) continue;
    if (keepR + keepN + keepC === 0) continue; // 至少留一个攻子，否则马炮项又走不到

    // 深拷贝初始布局，按类型随机保留 keepX 个（双方对称）
    var grid = [];
    for (var r = 0; r < 10; r++) grid.push(INIT_GRID[r].slice());
    var picks = [
      ['R', 'r', keepR], ['N', 'n', keepN], ['C', 'c', keepC],
      ['A', 'a', keepA], ['B', 'b', keepB], ['P', 'p', keepP]
    ];
    for (var pi = 0; pi < picks.length; pi++) {
      var red = picks[pi][0], black = picks[pi][1], keep = picks[pi][2];
      [red, black].forEach(function (ch) {
        var cells = [];
        for (var rr = 0; rr < 10; rr++) {
          for (var ff = 0; ff < 9; ff++) if (grid[rr][ff] === ch) cells.push([rr, ff]);
        }
        // 随机洗牌后把多余的清掉
        for (var i = cells.length - 1; i > 0; i--) {
          var j = (rng() * (i + 1)) | 0;
          var tmp = cells[i]; cells[i] = cells[j]; cells[j] = tmp;
        }
        for (var k = keep; k < cells.length; k++) grid[cells[k][0]][cells[k][1]] = '';
      });
    }

    var fen = gridToFen(grid);
    var pos = new Position(fen);
    if (MG.isChecked(pos, pos.side)) continue;
    var key = fen.split(' ')[0] + ' ' + fen.split(' ')[1];
    if (seen[key]) continue;
    seen[key] = 1;
    out.push(fen);
  }
  return out;
}

/**
 * 生成局面。
 * @param {string} [phase] 'mid'（默认）随机走 10~23 手；'end' 残局（按类型成对删子，
 *        双方子力和 < ENDGAME_MATERIAL、子力相等）。
 *
 * 为什么必须有 'end'：只测中局的话**残局相关的评估项（兵值缩放、马炮残局调整、
 * 残局系数）根本不会被走到**——2026-09-28 查出来默认套件 50 个局面全是非残局。
 */
function genPositions(rng, count, phase) {
  if (phase === 'end') return genEndgameFens(rng, count);

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

/** 双方子力和（不含将帅） */
function totalMaterial(pos) {
  var s = 0;
  for (var i = 0; i < C.BOARD_SIZE; i++) {
    var p = pos.board[i];
    if (p === C.EMPTY) continue;
    var t = p > 0 ? p : -p;
    if (t === 1) continue;
    s += EV.PIECE_VALUE[t];
  }
  return s;
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

  function cfgText(cfg) {
    var d = cfg.depth || A.LEVELS[cfg.level].depth;
    return cfg.level + '(d' + d + ')';
  }

  // 跑一套局面，返回胜负和
  function runSuite(seed, positions) {
    var fens = genPositions(makeRng(seed), positions, 'mid');
    if (fens.length < positions) {
      console.log('  ⚠ 中局局面只生成出 ' + fens.length + '/' + positions + ' 个');
    }
    if (o.endgame > 0) {
      var ef = genPositions(makeRng(seed ^ 0x5bf03635), o.endgame, 'end');
      if (ef.length < o.endgame) {
        console.log('  ⚠ 残局局面只生成出 ' + ef.length + '/' + o.endgame + ' 个（结果仍有效，但"残局占比"没有标称的那么高）');
      }
      fens = fens.concat(ef);
    }
    var a = 0, b = 0, d = 0;
    fens.forEach(function (fen) {
      [true, false].forEach(function (aIsRed) {
        var res = play(A, B, fen, aIsRed, cfgA, cfgB);
        if (res === 'A') a++;
        else if (res === 'B') b++;
        else d++;
      });
    });
    return { a: a, b: b, d: d, n: fens.length * 2 };
  }

  // ---- 多套件模式 ----
  // 单一局面套件的结果受**局面抽样偏差**影响：同一对照换套局面，结论可能变号
  // （2026-09-28 实测 LMR 那条从 +2 变 −5）。所以判定评估类改动要看多套局面是否同号。
  if (o.suites > 1 && !o.json) {
    var cp = require('child_process');
    var seeds = [];
    for (var si = 0; si < o.suites; si++) seeds.push(o.seed + si * 7919);
    var results = new Array(seeds.length);
    var finished = 0;

    var perSuite = o.positions + o.endgame;
    console.log('多套件对抗：' + o.suites + ' 套局面，每套 ' + perSuite + ' 局面（' +
      o.positions + ' 中局 + ' + o.endgame + ' 残局）= ' + (perSuite * 2) + ' 局，合计 ' +
      (o.suites * perSuite * 2) + ' 局');
    console.log('  当前 ' + cfgText(cfgA) + ' / 对照 ' + cfgText(cfgB) + '，固定深度、无随机化\n');

    function report() {
      var nets = [];
      results.forEach(function (r, idx) {
        if (!r) { console.log('  套件 ' + (idx + 1) + '：跑失败'); return; }
        nets.push(r.a - r.b);
        var want = (o.positions + o.endgame) * 2;
        var short = r.n !== want ? '  ⚠ 只跑了 ' + r.n + '/' + want + ' 局' : '';
        console.log('  套件 ' + (idx + 1) + '（种子 ' + seeds[idx] + '）：净 ' +
          String(r.a - r.b).padStart(4) + '   ' + r.a + '胜/' + r.d + '和/' + r.b + '负' + short);
      });
      if (!nets.length) return;
      var sum = 0, min = nets[0], max = nets[0], pos = 0, neg = 0, zero = 0;
      nets.forEach(function (v) {
        sum += v;
        if (v < min) min = v;
        if (v > max) max = v;
        if (v > 0) pos++; else if (v < 0) neg++; else zero++;
      });
      console.log('\n  合计净 ' + sum + '（' + (nets.length * (o.positions + o.endgame) * 2) + ' 局）');
      console.log('  各套件：' + nets.map(function (v) { return (v > 0 ? '+' : '') + v; }).join(' ') +
        '   范围 ' + min + ' ~ ' + max);
      var verdict;
      if (pos > 0 && neg === 0) verdict = '全部同号（' + pos + ' 套为正）→ 方向可信，幅度看合计净';
      else if (neg > 0 && pos === 0) verdict = '全部同号（' + neg + ' 套为负）→ 方向可信，幅度看合计净';
      else if (pos === 0 && neg === 0) verdict = '各套件全为 0 → 无差别';
      else verdict = '**有正有负**（' + pos + ' 正 / ' + neg + ' 负）→ 效应落在抽样偏差之下，判不出来';
      console.log('  判读：' + verdict);
    }

    seeds.forEach(function (sd, idx) {
      var args = [o.control, '--positions', String(o.positions), '--seed', String(sd),
        '--json', '--level', o.levelA + ':' + o.levelB,
        '--endgame', String(o.endgame)];
      if (o.depthA) args.push('--depth', o.depthA + ':' + (o.depthB || o.depthA));
      var ch = cp.fork(__filename, args, { silent: true });
      var buf = '';
      ch.stdout.on('data', function (c) { buf += c; });
      ch.on('exit', function () {
        try { results[idx] = JSON.parse(buf.trim().split('\n').pop()); }
        catch (e) { results[idx] = null; }
        if (++finished === seeds.length) report();
      });
    });
    return;
  }

  var r = runSuite(o.seed, o.positions);

  if (o.json) {
    console.log(JSON.stringify({ a: r.a, b: r.b, d: r.d, n: r.n, seed: o.seed }));
    return;
  }

  console.log('确定性多局面对抗：当前 vs ' + o.control);
  console.log('  当前 ' + cfgText(cfgA) + ' / 对照 ' + cfgText(cfgB) +
    '，无随机化，' + (r.n / 2) + ' 局面（' + o.positions + ' 中局 + ' + o.endgame +
    ' 残局）× 正反两色 = ' + r.n + ' 局');
  console.log('  当前 ' + r.a + ' 胜 ' + r.d + ' 和 ' + r.b + ' 负  →  净 ' + (r.a - r.b));
  console.log('  （同引擎对照恒为净 0；净 ≥ 10 才算有信号，净 < 10 视为持平）');
  console.log('  提示：单套局面的结果受**局面抽样偏差**影响（换套局面可能变号）。');
  console.log('        判定评估类改动请加 --suites 4，看多套局面是否同号。');
}

main();
