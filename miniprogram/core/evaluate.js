/**
 * 局面评估：子力价值 + 位置价值表(PST) + 残局修正
 *
 * 所有位置表均以"红方视角"书写（rank 0 在数组最前，即屏幕上方/黑方底线）。
 * 黑方棋子使用垂直镜像索引查表，从而与红方共用同一份表。
 * 返回值：正数对红方有利，负数对黑方有利。
 */

var C = require('./constants.js');

/** 子力基础价值（百分之一子，即 centipawn） */
var PIECE_VALUE = {
  1: 10000, // 帅/将：不可被吃，仅用于兜底
  2: 200, // 仕/士
  3: 200, // 相/象
  4: 400, // 马
  5: 900, // 车
  6: 450, // 炮
  7: 70 // 兵/卒
};

/** 由 10 行 × 9 列的二维数组展开为 90 长度的一维表 */
function buildTable(rows) {
  var table = [];
  for (var r = 0; r < C.RANKS; r++) {
    var row = rows[r];
    for (var f = 0; f < C.FILES; f++) {
      table.push(row[f] || 0);
    }
  }
  return table;
}

// 兵/卒：过河后价值陡增，深入九宫附近最高；沉底后反而减弱（只能横走）
var PAWN_TABLE = buildTable([
  [0, 15, 35, 45, 50, 45, 35, 15, 0],
  [55, 75, 105, 125, 130, 125, 105, 75, 55],
  [60, 80, 100, 115, 120, 115, 100, 80, 60],
  [55, 70, 85, 95, 100, 95, 85, 70, 55],
  [40, 55, 65, 75, 80, 75, 65, 55, 40],
  [10, 0, 20, 0, 25, 0, 20, 0, 10],
  [5, 0, 8, 0, 12, 0, 8, 0, 5],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0]
]);

// 马：中路与河口最活跃；卧槽马位（对方九宫两侧）给高分；边角与底线受限
var KNIGHT_TABLE = buildTable([
  [0, -2, 6, 6, -4, 6, 6, -2, 0],
  [2, 8, 16, 24, 12, 24, 16, 8, 2],
  [6, 12, 18, 20, 16, 20, 18, 12, 6],
  [4, 14, 16, 20, 18, 20, 16, 14, 4],
  [2, 16, 14, 18, 16, 18, 14, 16, 2],
  [2, 12, 16, 14, 12, 14, 16, 12, 2],
  [2, 6, 10, 8, 6, 8, 10, 6, 2],
  [0, 4, 8, 6, 10, 6, 8, 4, 0],
  [0, 2, 4, 6, 6, 6, 4, 2, 0],
  [0, -4, 0, 0, 0, 0, 0, -4, 0]
]);

// 车：对方底线/二路最具威胁，中路与骑河线次之
var ROOK_TABLE = buildTable([
  [14, 14, 12, 18, 16, 18, 12, 14, 14],
  [16, 20, 18, 24, 26, 24, 18, 20, 16],
  [12, 12, 12, 18, 18, 18, 12, 12, 12],
  [12, 18, 16, 22, 22, 22, 16, 18, 12],
  [12, 14, 12, 18, 18, 18, 12, 14, 12],
  [12, 16, 14, 20, 20, 20, 14, 16, 12],
  [6, 10, 8, 14, 14, 14, 8, 10, 6],
  [4, 8, 6, 14, 12, 14, 6, 8, 4],
  [8, 4, 8, 16, 8, 16, 8, 4, 8],
  [-2, 10, 6, 14, 12, 14, 6, 10, -2]
]);

// 炮：中路与对方宫顶线最有力（当头炮、宫顶炮），己方底线次之
var CANNON_TABLE = buildTable([
  [0, 0, 2, 6, 10, 6, 2, 0, 0],
  [0, 2, 4, 6, 8, 6, 4, 2, 0],
  [2, 4, 6, 6, 10, 6, 6, 4, 2],
  [2, 2, 4, 6, 10, 6, 4, 2, 2],
  [2, 2, 4, 6, 8, 6, 4, 2, 2],
  [4, 2, 6, 6, 10, 6, 6, 2, 4],
  [2, 2, 2, 4, 8, 4, 2, 2, 2],
  [6, 4, 0, 8, 14, 8, 0, 4, 6],
  [2, 2, 0, 4, 6, 4, 0, 2, 2],
  [0, 2, 2, 6, 10, 6, 2, 2, 0]
]);

// 仕：留在己方九宫，撑起联防略优；花心仕会堵住帅路，给予负分
var ADVISOR_TABLE = buildTable([
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, -4, 0, 0, 0, 0],
  [0, 0, 0, 4, -6, 4, 0, 0, 0],
  [0, 0, 0, 2, 0, 2, 0, 0, 0]
]);

// 相：河头相与中相位最佳
var BISHOP_TABLE = buildTable([
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 2, 0, 3, 0, 2, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [3, 0, 0, 0, 4, 0, 0, 0, 3],
  [0, 0, 2, 0, 3, 0, 2, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [3, 0, 0, 0, 4, 0, 0, 0, 3],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 2, 0, 0, 0, 2, 0, 0]
]);

// 帅：以原位最安全，上二楼/出宫风险递增
var KING_TABLE = buildTable([
  [0, 0, 0, -12, -16, -12, 0, 0, 0],
  [0, 0, 0, -6, -10, -6, 0, 0, 0],
  [0, 0, 0, -4, -6, -4, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, -10, -14, -10, 0, 0, 0],
  [0, 0, 0, -4, -8, -4, 0, 0, 0],
  [0, 0, 0, -2, 0, -2, 0, 0, 0]
]);

/** 按棋子类型（绝对值）索引的位置表 */
var PST = {
  1: KING_TABLE,
  2: ADVISOR_TABLE,
  3: BISHOP_TABLE,
  4: KNIGHT_TABLE,
  5: ROOK_TABLE,
  6: CANNON_TABLE,
  7: PAWN_TABLE
};

// 残局判定阈值：双方非将帅子力总和低于该值时视为进入残局
var ENDGAME_MATERIAL = 2200;

/**
 * 评估局面
 * @param {Position} pos
 * @returns {number} 红方视角的分值
 */
function evaluate(pos) {
  var board = pos.board;
  var score = 0;
  var redMaterial = 0;
  var blackMaterial = 0;
  var i, piece, type, value;

  for (i = 0; i < C.BOARD_SIZE; i++) {
    piece = board[i];
    if (piece === C.EMPTY) continue;
    type = piece > 0 ? piece : -piece;
    if (type === 1) continue; // 将帅价值不计入子力统计
    value = PIECE_VALUE[type];
    if (piece > 0) redMaterial += value;
    else blackMaterial += value;
  }

  // 残局系数 0~1：子力越少，兵（卒）与将帅活动性的权重越高
  var totalMaterial = redMaterial + blackMaterial;
  var endgame = totalMaterial >= ENDGAME_MATERIAL
    ? 0
    : (ENDGAME_MATERIAL - totalMaterial) / ENDGAME_MATERIAL;

  for (i = 0; i < C.BOARD_SIZE; i++) {
    piece = board[i];
    if (piece === C.EMPTY) continue;
    type = piece > 0 ? piece : -piece;
    var positional = PST[type][piece > 0 ? i : C.mirrorIdx(i)];

    if (type === 7) {
      // 残局时过河兵价值显著提升
      positional = Math.round(positional * (1 + endgame * 0.6));
    } else if (type === 4) {
      // 残局时马缺少炮架配合、且子力稀薄，价值略降
      positional = Math.round(positional * (1 - endgame * 0.25));
    }

    if (piece > 0) {
      score += PIECE_VALUE[type] + positional;
    } else {
      score -= PIECE_VALUE[type] + positional;
    }
  }

  // 士象全的防御加成：对方有炮时，缺士象风险更大
  var redDefence = countDefenders(board, C.RED);
  var blackDefence = countDefenders(board, C.BLACK);
  var redHasCannon = hasPieceType(board, C.R_CANNON);
  var blackHasCannon = hasPieceType(board, C.B_CANNON);
  if (blackHasCannon) score += redDefence * 12;
  if (redHasCannon) score -= blackDefence * 12;

  return score;
}

/** 统计某方仕+相的数量 */
function countDefenders(board, side) {
  var a = side === C.RED ? C.R_ADVISOR : C.B_ADVISOR;
  var b = side === C.RED ? C.R_BISHOP : C.B_BISHOP;
  var n = 0;
  for (var i = 0; i < C.BOARD_SIZE; i++) {
    var p = board[i];
    if (p === a || p === b) n++;
  }
  return n;
}

function hasPieceType(board, piece) {
  for (var i = 0; i < C.BOARD_SIZE; i++) {
    if (board[i] === piece) return true;
  }
  return false;
}

/**
 * 以当前走子方视角评估（negamax 使用）
 */
function evaluateForSide(pos) {
  var s = evaluate(pos);
  return pos.side === C.RED ? s : -s;
}

/**
 * 单个棋子的静态价值（用于 MVV-LVA 走法排序）
 */
function pieceValue(piece) {
  if (piece === C.EMPTY) return 0;
  return PIECE_VALUE[piece > 0 ? piece : -piece];
}

module.exports = {
  PIECE_VALUE: PIECE_VALUE,
  PST: PST,
  evaluate: evaluate,
  evaluateForSide: evaluateForSide,
  pieceValue: pieceValue,
  ENDGAME_MATERIAL: ENDGAME_MATERIAL
};
