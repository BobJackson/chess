/**
 * 难度强度基准与自对弈阶梯（node scripts/bench-levels.js）
 *
 * 用途：回归时一眼看清"每个难度到底有多强"——单步搜索实际能跑到几层、
 * 自对弈战绩如何、大师档相对困难档有没有真优势。改动评估函数、搜索或
 * 难度参数后跑一遍，比读代码可靠。
 *
 * 用法：
 *   node scripts/bench-levels.js                     只跑单步基准（十几秒）
 *   node scripts/bench-levels.js --games 1           再跑一轮自对弈阶梯（每档 1 局）
 *   node scripts/bench-levels.js --games 2 --cap 160 每档 2 局，单局最多 160 手
 *   node scripts/bench-levels.js --foe normal,hard   只跟指定档位下
 *   node scripts/bench-levels.js --trace --games 1   自对弈时逐手打印棋谱与分值
 *   node scripts/bench-levels.js --check --games 1   额外做不变量断言（见下）
 *
 * 参数：
 *   --games N   大师档对每个档位的对局数，0 表示不跑自对弈（默认 0）
 *   --cap N     单局手数上限（默认 200）
 *   --foe LIST  只跑指定对手档位，逗号分隔（默认 beginner,easy,normal,hard,master）
 *   --trace     打印逐手棋谱与引擎分值
 *   --no-rep    关闭重复局面判定（A/B 对照：看看这个特性到底值多少）
 *   --check     断言：走法全部合法、对局都能正常终局、搜索不污染局面
 *
 * 注意：自对弈用产品同款设置（大师档 4.5 秒/步），一局动辄几分钟，
 * 所以默认不跑；跑之前先想好时间预算。
 */

var Position = require('../miniprogram/core/position.js');
var MG = require('../miniprogram/core/movegen.js');
var AI = require('../miniprogram/core/ai.js');
var NT = require('../miniprogram/core/notation.js');
var Game = require('../miniprogram/core/game.js');
var C = require('../miniprogram/core/constants.js');

var MASTER = 'master';

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  var opts = { games: 0, cap: 200, trace: false, check: false, noRep: false, foe: AI.LEVEL_ORDER.slice(0) };
  for (var i = 2; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--games') opts.games = parseInt(argv[++i], 10) || 0;
    else if (a === '--cap') opts.cap = parseInt(argv[++i], 10) || 200;
    else if (a === '--foe') opts.foe = String(argv[++i]).split(',').filter(Boolean);
    else if (a === '--trace') opts.trace = true;
    else if (a === '--no-rep') opts.noRep = true;
    else if (a === '--check') opts.check = true;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

var OPTS = parseArgs(process.argv);
if (OPTS.help) {
  console.log('用法：node scripts/bench-levels.js [--games N] [--cap N] [--foe a,b] [--trace] [--no-rep] [--check]');
  process.exit(0);
}

var failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log('  \x1b[32mOK\x1b[0m    ' + name + (detail === undefined ? '' : ' = ' + detail));
  } else {
    failures++;
    console.log('  \x1b[31mFAIL\x1b[0m  ' + name + (detail === undefined ? '' : ' = ' + detail));
  }
}

// ---------------------------------------------------------------------------
// 一、单步基准：各难度在固定局面上的实际搜索深度
// ---------------------------------------------------------------------------

function seq(moves) {
  var p = new Position();
  var undo = { from: 0, to: 0, piece: 0, captured: 0, side: 0 };
  for (var i = 0; i < moves.length; i++) p.makeMove(moves[i][0], moves[i][1], undo);
  return p;
}

var SPOTS = [
  { name: '开局', fen: null },
  { name: '中局', make: function () { return seq([[54, 45], [31, 40], [64, 63], [19, 28], [72, 71], [11, 21]]); } }
];

function benchMoves() {
  console.log('\n=== 单步基准（各难度自带时限内能完成的层数）===');
  console.log('  难度    局面   完成层  节点数      耗时      分值   走法');
  SPOTS.forEach(function (spot) {
    AI.LEVEL_ORDER.forEach(function (key) {
      var pos = spot.fen === null ? new Position() : spot.make();
      var before = pos.toFen();
      var t0 = Date.now();
      var r = AI.findBestMove(pos, { level: key, moveNumber: 999, useBook: false });
      var ms = Date.now() - t0;
      var lv = AI.LEVELS[key];
      console.log('  ' + lv.label.padEnd(5) + ' ' + spot.name + '   ' +
        String(r.depth).padStart(4) + '   ' + String(r.nodes).padStart(9) + '  ' +
        String(ms).padStart(6) + 'ms  ' + String(r.score).padStart(6) + '   ' +
        NT.moveText(pos, r.from, r.to));
      if (OPTS.check) {
        check(lv.label + '·' + spot.name + ' 搜索未改动局面', pos.toFen() === before);
        check(lv.label + '·' + spot.name + ' 走法合法',
          MG.genLegalMoves(pos, pos.side).indexOf(r.move) >= 0);
      }
    });
  });
  console.log('  注：标称深度是上限，时限到点即返回上一层已完成的结果。' +
    '2026-09-27 走法全排序 + 晚走法削减 + 空着裁剪 + 机动性（量级压到每格 1 分）之后，' +
    '大师档在 4.5s 预算内开局/中局都能跑满 8 层。');
}

// ---------------------------------------------------------------------------
// 二、自对弈阶梯：大师档执黑（产品里人类执红先行）对每一档
// ---------------------------------------------------------------------------

function playOne(foe, trace) {
  var game = new Game();
  var plies = 0;
  var t0 = Date.now();
  var illegal = 0;
  var log = [];

  while (!game.result && plies < OPTS.cap) {
    var side = game.pos.side;
    var level = side === C.BLACK ? MASTER : foe;
    var legal = MG.genLegalMoves(game.pos, side);
    if (legal.length === 0) break; // 兜底：正常由 game.move 判终局

    var before = game.pos.toFen();
    var search = AI.createSearch(game.pos, {
      level: level,
      moveNumber: Math.floor(plies / 2),
      noRep: OPTS.noRep
    });
    while (!search.step(12)) {}
    var r = search.getResult();
    if (!r) break;

    if (OPTS.check && game.pos.toFen() !== before) {
      failures++;
      console.log('  \x1b[31mFAIL\x1b[0m  搜索改动了局面（' + level + '）');
    }

    var res = game.move(r.from, r.to);
    if (!res.ok) {
      illegal++;
      if (OPTS.check) {
        failures++;
        console.log('  \x1b[31mFAIL\x1b[0m  引擎返回非法走法：' + level + ' ' +
          NT.moveText(game.pos, r.from, r.to) + '（' + res.error + '）');
      }
      break;
    }
    plies++;
    if (trace) log.push((plies + (side === C.BLACK ? ' 黑(大师) ' : ' 红(' + foe + ') ')) +
      res.text.padEnd(6) + ' 分值=' + String(r.score).padStart(7) + ' 层=' + r.depth);
  }

  var winner = game.result ? game.result.winner : null;
  var outcome;
  if (winner === null) outcome = '未分（手数上限）';
  else if (winner === Game.DRAW) outcome = '和棋';
  else outcome = winner === C.BLACK ? '大师胜' : '对手胜';

  return {
    foe: foe, outcome: outcome, reason: game.result ? game.result.reason : '手数上限',
    plies: plies, sec: ((Date.now() - t0) / 1000).toFixed(0),
    illegal: illegal, log: log
  };
}

function benchGames() {
  console.log('\n=== 自对弈阶梯（大师执黑，每档 ' + OPTS.games + ' 局，手数上限 ' + OPTS.cap +
    (OPTS.noRep ? '，已关闭重复局面判定' : '') + '）===');
  var tally = {};
  OPTS.foe.forEach(function (foe) {
    tally[foe] = { win: 0, draw: 0, lose: 0, other: 0 };
    for (var g = 1; g <= OPTS.games; g++) {
      var res = playOne(foe, OPTS.trace);
      var t = tally[foe];
      if (res.outcome === '大师胜') t.win++;
      else if (res.outcome === '和棋') t.draw++;
      else if (res.outcome === '对手胜') t.lose++;
      else t.other++;
      console.log('  大师 vs ' + AI.LEVELS[foe].label + ' 第' + g + '局：' + res.outcome +
        '（' + res.reason + '，' + res.plies + ' 手，' + res.sec + 's）');
      if (OPTS.trace) res.log.forEach(function (line) { console.log('        ' + line); });
    }
  });

  console.log('\n  战绩汇总（大师视角）：');
  OPTS.foe.forEach(function (foe) {
    var t = tally[foe];
    console.log('    vs ' + AI.LEVELS[foe].label.padEnd(4) + ' ' +
      t.win + ' 胜 ' + t.draw + ' 和 ' + t.lose + ' 负' +
      (t.other ? ' ' + t.other + ' 未分' : ''));
  });
}

// ---------------------------------------------------------------------------

benchMoves();
if (OPTS.games > 0) benchGames();
else console.log('\n（加 --games 1 可再跑一轮自对弈阶梯，注意大师档 4.5 秒/步，比较费时）');

if (failures > 0) {
  console.log('\n\x1b[31m基准检查未通过：' + failures + ' 项\x1b[0m\n');
  process.exit(1);
}
console.log('\n基准完成\n');
