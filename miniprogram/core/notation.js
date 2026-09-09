/**
 * 中文着法记谱（炮二平五 / 马8进7 / 前車进一）
 *
 * 规则要点：
 *  - 纵线号：红方用汉字一~九，黑方用阿拉伯数字 1~9，均从己方右侧起算
 *  - 平：同一横线移动；进：朝对方方向；退：朝己方方向
 *  - 車/炮/兵/卒/将帅 的进退用「走过的格数」，马/象/士 的进退用「终点纵线号」
 *  - 同纵线上有多个同种棋子时用「前/二/三/四/后」代替纵线号
 *
 * 纯 JavaScript，无 wx 依赖。
 */

var C = require('./constants.js');
var MG = require('./movegen.js');

var CN_DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 斜线行走的棋子（进退记终点纵线号）：马、象、士 */
var DIAGONAL_TYPES = { 2: true, 3: true, 4: true };

/**
 * 纵线号：红方从右往左为 一~九，黑方从右往左为 1~9
 * 屏幕上红方在下（rank 9），其右侧是 file 8；黑方在上（rank 0），其右侧是 file 0
 */
function columnNumber(file, side) {
  return side === C.RED ? C.FILES - file : file + 1;
}

/** 按阵营输出数字文本（红方汉字、黑方阿拉伯数字） */
function numberText(n, side) {
  if (n < 1 || n > 9) return String(n);
  return side === C.RED ? CN_DIGITS[n] : String(n);
}

/**
 * 同纵线同种棋子的「前/后」序号标记
 * 从靠近对方的一侧往后依次为：前、二、三、四、后
 *
 * @param {number[]} ranks 同纵线同种棋子的 rank 列表（升序）
 * @param {number} rank 待标记棋子的 rank
 * @param {number} side 该棋子阵营
 * @returns {?string} 标记文本；只有 1 个同种棋子时返回 null（改用纵线号）
 */
function ordinalLabel(ranks, rank, side) {
  if (ranks.length < 2) return null;

  // 「前」= 更靠近对方：红方 rank 小者在前，黑方 rank 大者在前
  var ordered = ranks.slice(0);
  if (side === C.RED) ordered.sort(function (a, b) { return a - b; });
  else ordered.sort(function (a, b) { return b - a; });

  var index = ordered.indexOf(rank);
  if (index < 0) return null;

  var last = ordered.length - 1;
  if (index === 0) return '前';
  if (index === last) return '后';
  // 中间的按「二、三、四…」编号
  return numberText(index + 1, side);
}

/**
 * 生成一步棋的中文着法
 *
 * @param {Position} pos 走子「前」的局面
 * @param {number} from 起点索引
 * @param {number} to 终点索引
 * @returns {string} 如 "炮二平五"；棋子不存在时返回空串
 */
function moveText(pos, from, to) {
  var piece = pos.board[from];
  if (piece === C.EMPTY) return '';

  var side = C.sideOf(piece);
  var type = Math.abs(piece);
  var fromFile = C.fileOf(from);
  var fromRank = C.rankOf(from);
  var toFile = C.fileOf(to);
  var toRank = C.rankOf(to);
  var name = C.PIECE_NAMES[piece] || '?';

  // 收集同纵线上的同种棋子，用于「前/后」标记
  var sameFile = [];
  for (var i = 0; i < C.BOARD_SIZE; i++) {
    if (C.fileOf(i) !== fromFile) continue;
    if (pos.board[i] !== piece) continue;
    sameFile.push(C.rankOf(i));
  }

  // 「前/二/后」置于棋子名之前（如「前車进一」），纵线号置于棋子名之后（如「炮二平五」）
  var ordinal = ordinalLabel(sameFile, fromRank, side);
  var prefix = ordinal === null ? '' : ordinal;
  var locator = ordinal === null
    ? numberText(columnNumber(fromFile, side), side)
    : '';

  var action;
  var amount;
  if (toRank === fromRank) {
    action = '平';
    amount = numberText(columnNumber(toFile, side), side);
  } else {
    // 红方向上（rank 减小）为进，黑方向下（rank 增大）为进
    var forward = side === C.RED ? toRank < fromRank : toRank > fromRank;
    action = forward ? '进' : '退';
    if (DIAGONAL_TYPES[type]) {
      amount = numberText(columnNumber(toFile, side), side);
    } else {
      amount = numberText(Math.abs(toRank - fromRank), side);
    }
  }

  return prefix + name + locator + action + amount;
}

/**
 * 把着法列表排成回合文本
 * @param {string[]} texts 依次的中文着法（红方先手）
 * @returns {string[]} 每行一个回合，如 ["1. 炮二平五  马8进7", "2. 马二进三"]
 */
function formatMoveList(texts) {
  var lines = [];
  for (var i = 0; i < texts.length; i += 2) {
    var no = (i / 2) + 1;
    var line = no + '. ' + texts[i];
    if (texts[i + 1] !== undefined) line += '  ' + texts[i + 1];
    lines.push(line);
  }
  return lines;
}

/**
 * 从记谱文本还原走法（仅支持纵线号写法，如 "炮二平五"、"马8进7"）
 * 「前/后」写法因需要额外上下文，此处通过遍历合法走法反向匹配文本实现。
 *
 * @param {Position} pos 走子前的局面
 * @param {string} text 中文着法
 * @param {Array<number>} [legalMoves] 该局面下的合法走法（打包整数），缺省则不校验
 * @returns {?number} 打包走法，匹配不到返回 null
 */
function parseText(pos, text, legalMoves) {
  if (typeof text !== 'string' || text.length < 3) return null;
  if (!legalMoves || legalMoves.length === 0) return null;

  for (var i = 0; i < legalMoves.length; i++) {
    var move = legalMoves[i];
    if (moveText(pos, MG.moveFrom(move), MG.moveTo(move)) === text) return move;
  }
  return null;
}

module.exports = {
  columnNumber: columnNumber,
  numberText: numberText,
  moveText: moveText,
  formatMoveList: formatMoveList,
  parseText: parseText
};
