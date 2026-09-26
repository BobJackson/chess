/**
 * 局面（Position）：棋盘数组 + 走子方 + 走子/撤销 + FEN 读写
 *
 * 纯 JavaScript，无 wx 依赖。
 */

var C = require('./constants.js');

// ---------------------------------------------------------------------------
// Zobrist 哈希（置换表的键）
//
// piece 编码 -7..7 映射到下标 0..14（7 即空位，不用）；sideKey 在黑方走子时异或。
// 随机表用固定种子的 mulberry32 生成——测试因此可复现，且与运行环境无关。
// makeMove/unmakeMove 以异或增量维护 this.hash，O(1) 成本换置换表的可能。
// ---------------------------------------------------------------------------
var ZOBRIST = (function () {
  var seed = 0x9E3779B9;
  function rnd() {
    seed = (seed + 0x6D2B79F5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return t ^ (t >>> 14);
  }
  var piece = [];
  for (var p = 0; p < 15; p++) {
    var row = [];
    for (var i = 0; i < C.BOARD_SIZE; i++) row.push(rnd());
    piece.push(row);
  }
  return { piece: piece, side: rnd() };
})();

/** 由棋盘与走子方全量重算哈希（set 用 / 测试校验增量维护是否正确） */
function computeHash(board, side) {
  var h = 0;
  for (var i = 0; i < C.BOARD_SIZE; i++) {
    var p = board[i];
    if (p !== C.EMPTY) h ^= ZOBRIST.piece[p + 7][i];
  }
  if (side === C.BLACK) h ^= ZOBRIST.side;
  return h | 0;
}

/**
 * @constructor
 * @param {string} [fen] 省略则使用初始局面
 */
function Position(fen) {
  this.board = new Array(C.BOARD_SIZE);
  this.side = C.RED;
  // 双方将/帅所在位置缓存，避免每次遍历棋盘
  this.kingPos = [C.idxOf(4, 9), C.idxOf(4, 0)]; // [红, 黑]
  this.moveCount = 0;
  this.set(fen || C.START_FEN);
}

/** 载入 FEN（只解析棋子布局与走子方，其余字段忽略） */
Position.prototype.set = function (fen) {
  var parts = String(fen).trim().split(/\s+/);
  var rows = parts[0].split('/');
  var board = new Array(C.BOARD_SIZE);
  var i;
  for (i = 0; i < C.BOARD_SIZE; i++) board[i] = C.EMPTY;

  for (var rank = 0; rank < rows.length && rank < C.RANKS; rank++) {
    var file = 0;
    var row = rows[rank];
    for (var j = 0; j < row.length; j++) {
      var ch = row.charAt(j);
      if (ch >= '1' && ch <= '9') {
        file += parseInt(ch, 10);
      } else {
        var piece = C.FEN_CHAR_TO_PIECE[ch];
        if (piece !== undefined && file < C.FILES) {
          board[C.idxOf(file, rank)] = piece;
          file++;
        }
      }
    }
  }

  this.board = board;
  this.side = parts.length > 1 && parts[1] === 'b' ? C.BLACK : C.RED;
  this.hash = computeHash(this.board, this.side);
  this.rebuildKingPos();
  return this;
};

Position.prototype.rebuildKingPos = function () {
  this.kingPos = [-1, -1];
  for (var i = 0; i < C.BOARD_SIZE; i++) {
    var p = this.board[i];
    if (p === C.R_KING) this.kingPos[C.RED] = i;
    else if (p === C.B_KING) this.kingPos[C.BLACK] = i;
  }
};

/** 导出 FEN */
Position.prototype.toFen = function () {
  var rows = [];
  for (var rank = 0; rank < C.RANKS; rank++) {
    var row = '';
    var empty = 0;
    for (var file = 0; file < C.FILES; file++) {
      var p = this.board[C.idxOf(file, rank)];
      if (p === C.EMPTY) {
        empty++;
      } else {
        if (empty > 0) { row += empty; empty = 0; }
        row += C.PIECE_TO_FEN_CHAR[p];
      }
    }
    if (empty > 0) row += empty;
    rows.push(row);
  }
  return rows.join('/') + ' ' + (this.side === C.RED ? 'w' : 'b') + ' - - 0 1';
};

/** 复制一份局面 */
Position.prototype.clone = function () {
  var p = new Position();
  p.board = this.board.slice(0);
  p.side = this.side;
  p.kingPos = [this.kingPos[0], this.kingPos[1]];
  p.moveCount = this.moveCount;
  p.hash = this.hash;
  return p;
};

/** 当前走子方对手 */
Position.prototype.opponent = function () {
  return this.side === C.RED ? C.BLACK : C.RED;
};

Position.prototype.get = function (idx) {
  return this.board[idx];
};

/**
 * 走子。调用方需保证走法合法（由 movegen 生成）。
 * 为避免高频搜索时产生大量临时对象，撤销信息写入调用方传入的 undo 对象。
 *
 * @param {number} from 起点索引
 * @param {number} to 终点索引
 * @param {object} undo 撤销记录对象（会被覆写）
 */
Position.prototype.makeMove = function (from, to, undo) {
  var board = this.board;
  var piece = board[from];
  var captured = board[to];
  var side = this.side;

  undo.from = from;
  undo.to = to;
  undo.piece = piece;
  undo.captured = captured;
  undo.side = side;

  board[to] = piece;
  board[from] = C.EMPTY;

  // 哈希增量：动子离开 from、落到 to，被吃子离开 to，走子方换手
  var h = this.hash ^ ZOBRIST.piece[piece + 7][from] ^ ZOBRIST.piece[piece + 7][to];
  if (captured !== C.EMPTY) h ^= ZOBRIST.piece[captured + 7][to];
  this.hash = (h ^ ZOBRIST.side) | 0;

  if (piece === C.R_KING) this.kingPos[C.RED] = to;
  else if (piece === C.B_KING) this.kingPos[C.BLACK] = to;
  else if (captured === C.R_KING) this.kingPos[C.RED] = -1;
  else if (captured === C.B_KING) this.kingPos[C.BLACK] = -1;

  this.side = side === C.RED ? C.BLACK : C.RED;
  this.moveCount++;
};

/**
 * 撤销走子
 * @param {object} undo makeMove 写入的撤销记录
 */
Position.prototype.unmakeMove = function (undo) {
  var board = this.board;
  board[undo.from] = undo.piece;
  board[undo.to] = undo.captured;

  // 异或自逆：把 makeMove 的三组异或原样再来一遍即还原
  var h = this.hash ^ ZOBRIST.piece[undo.piece + 7][undo.from] ^ ZOBRIST.piece[undo.piece + 7][undo.to];
  if (undo.captured !== C.EMPTY) h ^= ZOBRIST.piece[undo.captured + 7][undo.to];
  this.hash = (h ^ ZOBRIST.side) | 0;

  if (undo.piece === C.R_KING) this.kingPos[C.RED] = undo.from;
  else if (undo.piece === C.B_KING) this.kingPos[C.BLACK] = undo.from;
  else if (undo.captured === C.R_KING) this.kingPos[C.RED] = undo.to;
  else if (undo.captured === C.B_KING) this.kingPos[C.BLACK] = undo.to;

  this.side = undo.side;
  this.moveCount--;
};

/** 创建一个可复用的撤销记录对象池 */
Position.createUndoPool = function (size) {
  var pool = [];
  for (var i = 0; i < size; i++) {
    pool.push({ from: 0, to: 0, piece: 0, captured: 0, side: 0 });
  }
  return pool;
};

/** 局面指纹，用于重复局面检测（不含走子方，重复判定另行组合） */
Position.prototype.signature = function () {
  var s = '';
  for (var i = 0; i < C.BOARD_SIZE; i++) {
    s += String.fromCharCode(this.board[i] + 72);
  }
  return s + (this.side === C.RED ? 'w' : 'b');
};

/** 统计某方在棋盘上的棋子总数（含将/帅） */
Position.prototype.countPieces = function (side) {
  var n = 0;
  for (var i = 0; i < C.BOARD_SIZE; i++) {
    var p = this.board[i];
    if (p !== C.EMPTY && C.sideOf(p) === side) n++;
  }
  return n;
};

module.exports = Position;
module.exports.ZOBRIST = ZOBRIST;
module.exports.computeHash = computeHash;
