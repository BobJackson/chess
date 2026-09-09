/**
 * 中国象棋核心常量与预计算走法表
 *
 * 棋盘坐标系：
 *   file(列) 0~8，rank(行) 0~9
 *   rank 0 = 黑方底线（屏幕上方），rank 9 = 红方底线（屏幕下方）
 *   一维索引 idx = rank * 9 + file
 *
 * 棋子编码：正数 = 红方，负数 = 黑方，0 = 空位
 *
 * 该文件为纯 JavaScript，不依赖任何 wx API，可在 Node 环境下单测。
 */

var FILES = 9;
var RANKS = 10;
var BOARD_SIZE = 90;

var EMPTY = 0;

// 红方
var R_KING = 1; // 帅
var R_ADVISOR = 2; // 仕
var R_BISHOP = 3; // 相
var R_KNIGHT = 4; // 马
var R_ROOK = 5; // 车
var R_CANNON = 6; // 炮
var R_PAWN = 7; // 兵

// 黑方
var B_KING = -1; // 将
var B_ADVISOR = -2; // 士
var B_BISHOP = -3; // 象
var B_KNIGHT = -4; // 马
var B_ROOK = -5; // 车
var B_CANNON = -6; // 炮
var B_PAWN = -7; // 卒

var RED = 0;
var BLACK = 1;

// 初始局面 FEN
var START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';

var FEN_CHAR_TO_PIECE = {
  k: B_KING, a: B_ADVISOR, b: B_BISHOP, n: B_KNIGHT, r: B_ROOK, c: B_CANNON, p: B_PAWN,
  K: R_KING, A: R_ADVISOR, B: R_BISHOP, N: R_KNIGHT, R: R_ROOK, C: R_CANNON, P: R_PAWN
};

var PIECE_TO_FEN_CHAR = {};
(function () {
  for (var ch in FEN_CHAR_TO_PIECE) {
    if (Object.prototype.hasOwnProperty.call(FEN_CHAR_TO_PIECE, ch)) {
      PIECE_TO_FEN_CHAR[FEN_CHAR_TO_PIECE[ch]] = ch;
    }
  }
})();

/** 棋子的中文名称（按阵营区分）；車采用传统字形，与实体棋具一致 */
var PIECE_NAMES = {
  1: '帅', 2: '仕', 3: '相', 4: '马', 5: '車', 6: '炮', 7: '兵',
  '-1': '将', '-2': '士', '-3': '象', '-4': '马', '-5': '車', '-6': '炮', '-7': '卒'
};

function idxOf(file, rank) {
  return rank * FILES + file;
}

function fileOf(idx) {
  return idx % FILES;
}

function rankOf(idx) {
  return (idx / FILES) | 0;
}

/** 取棋子所属阵营，空位返回 -1 */
function sideOf(piece) {
  if (piece > 0) return RED;
  if (piece < 0) return BLACK;
  return -1;
}

/** 垂直镜像索引（红黑两方的位置表可共用一份） */
function mirrorIdx(idx) {
  var f = idx % FILES;
  var r = (idx / FILES) | 0;
  return (RANKS - 1 - r) * FILES + f;
}

/** 是否在九宫内 */
function inPalace(file, rank, side) {
  if (file < 3 || file > 5) return false;
  return side === RED ? rank >= 7 && rank <= 9 : rank >= 0 && rank <= 2;
}

/** 是否在己方半场（象/相不能过河） */
function inOwnHalf(rank, side) {
  return side === RED ? rank >= 5 : rank <= 4;
}

// ---------------------------------------------------------------------------
// 预计算走法表
// ---------------------------------------------------------------------------

/** 帅/将：九宫内直行一步 */
var KING_MOVES = (function () {
  var table = [];
  var deltas = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  for (var idx = 0; idx < BOARD_SIZE; idx++) {
    var f = fileOf(idx);
    var r = rankOf(idx);
    var list = [];
    for (var i = 0; i < deltas.length; i++) {
      var nf = f + deltas[i][0];
      var nr = r + deltas[i][1];
      if (nf < 0 || nf > 8 || nr < 0 || nr > 9) continue;
      // 九宫范围对双方一致（file 3~5），只是 rank 区间不同
      var inBlackPalace = nr >= 0 && nr <= 2 && nf >= 3 && nf <= 5;
      var inRedPalace = nr >= 7 && nr <= 9 && nf >= 3 && nf <= 5;
      if (inBlackPalace || inRedPalace) list.push(idxOf(nf, nr));
    }
    table.push(list);
  }
  return table;
})();

/** 仕/士：九宫内斜行一步 */
var ADVISOR_MOVES = (function () {
  var table = [];
  var deltas = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  for (var idx = 0; idx < BOARD_SIZE; idx++) {
    var f = fileOf(idx);
    var r = rankOf(idx);
    var list = [];
    for (var i = 0; i < deltas.length; i++) {
      var nf = f + deltas[i][0];
      var nr = r + deltas[i][1];
      if (nf < 3 || nf > 5 || nr < 0 || nr > 9) continue;
      var inBlackPalace = nr >= 0 && nr <= 2;
      var inRedPalace = nr >= 7 && nr <= 9;
      if (inBlackPalace || inRedPalace) list.push(idxOf(nf, nr));
    }
    table.push(list);
  }
  return table;
})();

/** 相/象：田字，含象眼；不可过河。元素为 { to, eye } */
var BISHOP_MOVES = (function () {
  var table = [];
  var deltas = [[-2, -2], [2, -2], [-2, 2], [2, 2]];
  for (var idx = 0; idx < BOARD_SIZE; idx++) {
    var f = fileOf(idx);
    var r = rankOf(idx);
    var list = [];
    for (var i = 0; i < deltas.length; i++) {
      var nf = f + deltas[i][0];
      var nr = r + deltas[i][1];
      if (nf < 0 || nf > 8 || nr < 0 || nr > 9) continue;
      // 起点与终点必须在同一半场，等价于不可过河
      if (inOwnHalf(r, RED) !== inOwnHalf(nr, RED)) continue;
      list.push({
        to: idxOf(nf, nr),
        eye: idxOf(f + deltas[i][0] / 2, r + deltas[i][1] / 2)
      });
    }
    table.push(list);
  }
  return table;
})();

/** 马：日字，含马腿。元素为 { to, leg } */
var KNIGHT_MOVES = (function () {
  var table = [];
  // [目标偏移, 马腿偏移]
  var steps = [
    [[-1, -2], [0, -1]], [[1, -2], [0, -1]],
    [[-1, 2], [0, 1]], [[1, 2], [0, 1]],
    [[-2, -1], [-1, 0]], [[2, -1], [1, 0]],
    [[-2, 1], [-1, 0]], [[2, 1], [1, 0]]
  ];
  for (var idx = 0; idx < BOARD_SIZE; idx++) {
    var f = fileOf(idx);
    var r = rankOf(idx);
    var list = [];
    for (var i = 0; i < steps.length; i++) {
      var nf = f + steps[i][0][0];
      var nr = r + steps[i][0][1];
      if (nf < 0 || nf > 8 || nr < 0 || nr > 9) continue;
      list.push({
        to: idxOf(nf, nr),
        leg: idxOf(f + steps[i][1][0], r + steps[i][1][1])
      });
    }
    table.push(list);
  }
  return table;
})();

/** 兵/卒：按阵营区分（红向上，黑向下；过河后可横行） */
var PAWN_MOVES = (function () {
  var table = [[], []];
  for (var side = 0; side < 2; side++) {
    var forward = side === RED ? -1 : 1;
    for (var idx = 0; idx < BOARD_SIZE; idx++) {
      var f = fileOf(idx);
      var r = rankOf(idx);
      var list = [];
      var nr = r + forward;
      if (nr >= 0 && nr <= 9) list.push(idxOf(f, nr));
      // 过河后可左右横走
      var crossed = side === RED ? r <= 4 : r >= 5;
      if (crossed) {
        if (f > 0) list.push(idxOf(f - 1, r));
        if (f < 8) list.push(idxOf(f + 1, r));
      }
      table[side].push(list);
    }
  }
  return table;
})();

/**
 * 射线表：RAY_DIRS[idx][dir] = 从 idx 出发沿 dir 方向依次经过的所有格子
 * dir: 0=上(rank-1) 1=下(rank+1) 2=左(file-1) 3=右(file+1)
 */
var RAY_DIRS = (function () {
  var deltas = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  var table = [];
  for (var idx = 0; idx < BOARD_SIZE; idx++) {
    var f = fileOf(idx);
    var r = rankOf(idx);
    var dirs = [];
    for (var d = 0; d < 4; d++) {
      var ray = [];
      var nf = f + deltas[d][0];
      var nr = r + deltas[d][1];
      while (nf >= 0 && nf <= 8 && nr >= 0 && nr <= 9) {
        ray.push(idxOf(nf, nr));
        nf += deltas[d][0];
        nr += deltas[d][1];
      }
      dirs.push(ray);
    }
    table.push(dirs);
  }
  return table;
})();

module.exports = {
  FILES: FILES,
  RANKS: RANKS,
  BOARD_SIZE: BOARD_SIZE,
  EMPTY: EMPTY,
  R_KING: R_KING, R_ADVISOR: R_ADVISOR, R_BISHOP: R_BISHOP,
  R_KNIGHT: R_KNIGHT, R_ROOK: R_ROOK, R_CANNON: R_CANNON, R_PAWN: R_PAWN,
  B_KING: B_KING, B_ADVISOR: B_ADVISOR, B_BISHOP: B_BISHOP,
  B_KNIGHT: B_KNIGHT, B_ROOK: B_ROOK, B_CANNON: B_CANNON, B_PAWN: B_PAWN,
  RED: RED,
  BLACK: BLACK,
  START_FEN: START_FEN,
  FEN_CHAR_TO_PIECE: FEN_CHAR_TO_PIECE,
  PIECE_TO_FEN_CHAR: PIECE_TO_FEN_CHAR,
  PIECE_NAMES: PIECE_NAMES,
  idxOf: idxOf,
  fileOf: fileOf,
  rankOf: rankOf,
  sideOf: sideOf,
  mirrorIdx: mirrorIdx,
  inPalace: inPalace,
  inOwnHalf: inOwnHalf,
  KING_MOVES: KING_MOVES,
  ADVISOR_MOVES: ADVISOR_MOVES,
  BISHOP_MOVES: BISHOP_MOVES,
  KNIGHT_MOVES: KNIGHT_MOVES,
  PAWN_MOVES: PAWN_MOVES,
  RAY_DIRS: RAY_DIRS
};
