/**
 * 开局库
 *
 * 纯 PST 评估在开局阶段区分度不足（多路 quiet 走法分值并列），
 * 因此前几手直接从人工编排的主流开局库中按权重随机选取，
 * 既保证开局自然，也带来盘与盘之间的变化。
 *
 * 棋谱以 "起点file,起点rank-终点file,终点rank" 描述，红方在下方（rank 9）。
 */

var C = require('./constants.js');
var MG = require('./movegen.js');
var Position = require('./position.js');

/**
 * 主流开局线路，w 为权重（同一局面下多条线路汇聚到同一步时会累加）
 */
var BOOK_LINES = [
  // ---- 中炮对屏风马（最常见体系）----
  { w: 12, moves: ['7,7-4,7', '7,0-6,2', '7,9-6,7', '1,0-2,2', '8,9-8,7', '8,0-7,0', '8,7-7,7'] },
  { w: 10, moves: ['7,7-4,7', '1,0-2,2', '7,9-6,7', '7,0-6,2', '8,9-8,7', '0,0-1,0'] },
  { w: 8, moves: ['7,7-4,7', '7,0-6,2', '2,6-2,5', '2,3-2,4', '7,9-6,7', '1,0-2,2'] },
  // ---- 中炮对顺手炮 / 列手炮 ----
  { w: 6, moves: ['7,7-4,7', '7,2-4,2', '7,9-6,7', '7,0-6,2', '8,9-8,8', '8,0-7,0'] },
  { w: 5, moves: ['7,7-4,7', '1,2-4,2', '7,9-6,7', '1,0-2,2', '8,9-8,7', '0,0-1,0'] },
  // ---- 中炮对反宫马 / 单提马 ----
  { w: 5, moves: ['7,7-4,7', '1,0-0,2', '7,9-6,7', '7,0-6,2', '8,9-8,7'] },
  { w: 4, moves: ['7,7-4,7', '2,0-4,2', '7,9-6,7', '7,0-6,2', '8,9-8,7', '8,0-7,0'] },
  // ---- 仙人指路（进兵局）----
  { w: 9, moves: ['2,6-2,5', '7,2-6,2', '7,9-6,7', '1,0-2,2', '2,9-4,7', '6,3-6,4'] },
  { w: 8, moves: ['6,6-6,5', '1,2-2,2', '1,9-2,7', '1,0-0,2', '6,9-4,7', '7,0-6,2'] },
  { w: 6, moves: ['2,6-2,5', '2,3-2,4', '7,9-6,7', '7,0-6,2', '2,9-4,7'] },
  // ---- 飞相局 ----
  { w: 7, moves: ['6,9-4,7', '7,2-4,2', '7,9-6,7', '7,0-6,2', '1,9-2,7', '1,0-2,2'] },
  { w: 6, moves: ['2,9-4,7', '1,2-4,2', '1,9-2,7', '1,0-2,2', '7,9-6,7', '7,0-6,2'] },
  { w: 5, moves: ['6,9-4,7', '7,0-6,2', '7,9-6,7', '2,3-2,4', '2,6-2,5'] },
  // ---- 起马局 ----
  { w: 7, moves: ['7,9-6,7', '7,0-6,2', '2,6-2,5', '2,3-2,4', '1,9-2,7', '1,0-2,2'] },
  { w: 6, moves: ['1,9-2,7', '1,0-2,2', '6,6-6,5', '6,3-6,4', '7,9-6,7', '7,0-6,2'] },
  { w: 5, moves: ['7,9-6,7', '2,3-2,4', '1,7-4,7', '7,0-6,2', '8,9-8,7', '1,0-2,2'] },
  // ---- 仕角炮 / 过宫炮 / 兵底炮 ----
  { w: 4, moves: ['7,7-5,7', '7,0-6,2', '7,9-6,7', '1,0-2,2', '2,6-2,5'] },
  { w: 4, moves: ['1,7-3,7', '1,0-2,2', '1,9-2,7', '7,0-6,2', '6,6-6,5'] },
  { w: 3, moves: ['7,7-6,7', '7,0-6,2', '1,9-2,7', '1,0-2,2', '2,6-2,5', '2,3-2,4'] }
];

/**
 * 解析 "f,r-f,r" 为打包走法
 */
function parseMove(text) {
  var parts = String(text).split('-');
  if (parts.length !== 2) return null;
  var a = parts[0].split(',');
  var b = parts[1].split(',');
  if (a.length !== 2 || b.length !== 2) return null;
  var from = C.idxOf(parseInt(a[0], 10), parseInt(a[1], 10));
  var to = C.idxOf(parseInt(b[0], 10), parseInt(b[1], 10));
  if (isNaN(from) || isNaN(to)) return null;
  return MG.packMove(from, to);
}

/**
 * 构建开局库：局面指纹 -> [{ move, weight }]
 * 逐条线路回放，非法着法会被记录并在该处截断（保证库内全部合法）
 */
function buildBook() {
  var book = {};
  var errors = [];
  var undo = { from: 0, to: 0, piece: 0, captured: 0, side: 0 };

  BOOK_LINES.forEach(function (line, lineIdx) {
    var pos = new Position();
    for (var i = 0; i < line.moves.length; i++) {
      var move = parseMove(line.moves[i]);
      if (move === null) {
        errors.push('线路 ' + lineIdx + ' 第 ' + (i + 1) + ' 手格式错误: ' + line.moves[i]);
        break;
      }
      if (!MG.isMoveLegal(pos, pos.side, MG.moveFrom(move), MG.moveTo(move))) {
        errors.push('线路 ' + lineIdx + ' 第 ' + (i + 1) + ' 手非法: ' + line.moves[i]);
        break;
      }
      var sig = pos.signature();
      if (!book[sig]) book[sig] = {};
      book[sig][move] = (book[sig][move] || 0) + line.w;
      pos.makeMove(MG.moveFrom(move), MG.moveTo(move), undo);
    }
  });

  // 展开为数组形式，便于快速按权重抽取
  var table = {};
  for (var sig in book) {
    if (!Object.prototype.hasOwnProperty.call(book, sig)) continue;
    var entries = [];
    var total = 0;
    for (var mv in book[sig]) {
      if (!Object.prototype.hasOwnProperty.call(book[sig], mv)) continue;
      var weight = book[sig][mv];
      entries.push({ move: parseInt(mv, 10), weight: weight });
      total += weight;
    }
    table[sig] = { entries: entries, total: total };
  }

  return { table: table, errors: errors };
}

var BUILT = buildBook();
var BOOK = BUILT.table;

/**
 * 查开局库
 * @param {Position} pos
 * @returns {?number} 打包走法，未命中返回 null
 */
function getBookMove(pos) {
  var hit = BOOK[pos.signature()];
  if (!hit || hit.entries.length === 0) return null;

  var roll = Math.random() * hit.total;
  var acc = 0;
  for (var i = 0; i < hit.entries.length; i++) {
    acc += hit.entries[i].weight;
    if (roll < acc) return hit.entries[i].move;
  }
  return hit.entries[hit.entries.length - 1].move;
}

/** 开局库覆盖的局面数 */
function size() {
  return Object.keys(BOOK).length;
}

/** 构建期发现的错误（正常情况下为空数组） */
function buildErrors() {
  return BUILT.errors.slice(0);
}

module.exports = {
  BOOK_LINES: BOOK_LINES,
  parseMove: parseMove,
  getBookMove: getBookMove,
  size: size,
  buildErrors: buildErrors
};
