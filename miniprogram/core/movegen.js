/**
 * 走法生成与将军判定
 *
 * 走法在内部以整数打包：move = from * 100 + to（from/to 均为 0~89 的格子索引）
 * 搜索时走法写入调用方提供的扁平数组，避免频繁分配内存。
 */

var C = require('./constants.js');

function packMove(from, to) {
  return from * 100 + to;
}

function moveFrom(move) {
  return (move / 100) | 0;
}

function moveTo(move) {
  return move % 100;
}

// 从"将/帅"反查可能攻击它的马所在的 8 个位置
var KNIGHT_SOURCES = [
  [-1, -2], [1, -2], [-1, 2], [1, 2],
  [-2, -1], [2, -1], [-2, 1], [2, 1]
];

function abs(v) {
  return v > 0 ? v : -v;
}

/**
 * 生成伪合法走法（不排除送将），追加到 out 数组
 * @returns {number} 本次生成走法在 out 中的起始下标
 */
function genPseudoMoves(pos, side, out, capturesOnly) {
  var board = pos.board;
  var start = out.length;
  var i, t, target, dirs, ray, list;

  for (var from = 0; from < C.BOARD_SIZE; from++) {
    var piece = board[from];
    if (piece === C.EMPTY) continue;
    if (C.sideOf(piece) !== side) continue;

    switch (abs(piece)) {
      case 5: // 车
        dirs = C.RAY_DIRS[from];
        for (var d = 0; d < 4; d++) {
          ray = dirs[d];
          for (i = 0; i < ray.length; i++) {
            t = ray[i];
            target = board[t];
            if (target === C.EMPTY) {
              if (!capturesOnly) out.push(packMove(from, t));
            } else {
              if (C.sideOf(target) !== side) out.push(packMove(from, t));
              break;
            }
          }
        }
        break;

      case 6: // 炮：吃子必须隔一个"炮架"
        dirs = C.RAY_DIRS[from];
        for (var d2 = 0; d2 < 4; d2++) {
          ray = dirs[d2];
          var screened = false;
          for (i = 0; i < ray.length; i++) {
            t = ray[i];
            target = board[t];
            if (!screened) {
              if (target === C.EMPTY) {
                if (!capturesOnly) out.push(packMove(from, t));
              } else {
                screened = true;
              }
            } else if (target !== C.EMPTY) {
              if (C.sideOf(target) !== side) out.push(packMove(from, t));
              break;
            }
          }
        }
        break;

      case 4: // 马：蹩马腿
        list = C.KNIGHT_MOVES[from];
        for (i = 0; i < list.length; i++) {
          if (board[list[i].leg] !== C.EMPTY) continue;
          t = list[i].to;
          target = board[t];
          if (target === C.EMPTY) {
            if (!capturesOnly) out.push(packMove(from, t));
          } else if (C.sideOf(target) !== side) {
            out.push(packMove(from, t));
          }
        }
        break;

      case 3: // 相/象：塞象眼、不可过河
        list = C.BISHOP_MOVES[from];
        for (i = 0; i < list.length; i++) {
          if (board[list[i].eye] !== C.EMPTY) continue;
          t = list[i].to;
          target = board[t];
          if (target === C.EMPTY) {
            if (!capturesOnly) out.push(packMove(from, t));
          } else if (C.sideOf(target) !== side) {
            out.push(packMove(from, t));
          }
        }
        break;

      case 2: // 仕/士
        list = C.ADVISOR_MOVES[from];
        for (i = 0; i < list.length; i++) {
          t = list[i];
          target = board[t];
          if (target === C.EMPTY) {
            if (!capturesOnly) out.push(packMove(from, t));
          } else if (C.sideOf(target) !== side) {
            out.push(packMove(from, t));
          }
        }
        break;

      case 1: // 帅/将
        list = C.KING_MOVES[from];
        for (i = 0; i < list.length; i++) {
          t = list[i];
          target = board[t];
          if (target === C.EMPTY) {
            if (!capturesOnly) out.push(packMove(from, t));
          } else if (C.sideOf(target) !== side) {
            out.push(packMove(from, t));
          }
        }
        break;

      default: // 7 兵/卒
        list = C.PAWN_MOVES[side][from];
        for (i = 0; i < list.length; i++) {
          t = list[i];
          target = board[t];
          if (target === C.EMPTY) {
            if (!capturesOnly) out.push(packMove(from, t));
          } else if (C.sideOf(target) !== side) {
            out.push(packMove(from, t));
          }
        }
        break;
    }
  }

  return start;
}

/**
 * 判断某方的将/帅是否被攻击（含"将帅照面"，照面视为被攻击）
 * @param {Position} pos
 * @param {number} side 被检查的一方
 */
function isChecked(pos, side) {
  var kingIdx = pos.kingPos[side];
  if (kingIdx < 0) return true; // 将已不在棋盘（异常局面），按被将处理

  var board = pos.board;
  var kingFile = C.fileOf(kingIdx);
  var kingRank = C.rankOf(kingIdx);
  var enemy = side === C.RED ? C.BLACK : C.RED;

  var eKing = enemy === C.RED ? C.R_KING : C.B_KING;
  var eRook = enemy === C.RED ? C.R_ROOK : C.B_ROOK;
  var eCannon = enemy === C.RED ? C.R_CANNON : C.B_CANNON;
  var eKnight = enemy === C.RED ? C.R_KNIGHT : C.B_KNIGHT;
  var ePawn = enemy === C.RED ? C.R_PAWN : C.B_PAWN;

  var i, d, ray, piece, screened;

  // 1) 直线：车（首个子）、炮（隔一个子后的首个子）、将帅照面
  var dirs = C.RAY_DIRS[kingIdx];
  for (d = 0; d < 4; d++) {
    ray = dirs[d];
    screened = false;
    for (i = 0; i < ray.length; i++) {
      piece = board[ray[i]];
      if (piece === C.EMPTY) continue;
      if (!screened) {
        screened = true;
        if (piece === eRook || piece === eKing) return true;
      } else {
        if (piece === eCannon) return true;
        break;
      }
    }
  }

  // 2) 马：反查 8 个可能的马位，并验证马腿（马腿相对于马自身）
  for (i = 0; i < 8; i++) {
    var sf = kingFile + KNIGHT_SOURCES[i][0];
    var sr = kingRank + KNIGHT_SOURCES[i][1];
    if (sf < 0 || sf > 8 || sr < 0 || sr > 9) continue;
    var sIdx = C.idxOf(sf, sr);
    if (board[sIdx] !== eKnight) continue;
    var df = kingFile - sf;
    var dr = kingRank - sr;
    var legIdx;
    if (dr === 2 || dr === -2) {
      legIdx = C.idxOf(sf, sr + (dr > 0 ? 1 : -1));
    } else {
      legIdx = C.idxOf(sf + (df > 0 ? 1 : -1), sr);
    }
    if (board[legIdx] === C.EMPTY) return true;
  }

  // 3) 兵/卒：正前方一步 + 过河后的横向
  var frontRank = side === C.RED ? kingRank - 1 : kingRank + 1;
  if (frontRank >= 0 && frontRank <= 9) {
    if (board[C.idxOf(kingFile, frontRank)] === ePawn) return true;
  }
  for (i = -1; i <= 1; i += 2) {
    var nf = kingFile + i;
    if (nf < 0 || nf > 8) continue;
    var nIdx = C.idxOf(nf, kingRank);
    if (board[nIdx] !== ePawn) continue;
    // 敌兵必须已过河才能横走
    var crossed = enemy === C.RED ? kingRank <= 4 : kingRank >= 5;
    if (crossed) return true;
  }

  // 4) 仕/士、相/象无法攻击到对方将帅（活动范围不过河 / 不出九宫），无需判定
  return false;
}

/** 双方将帅是否照面（同一直线且中间无子） */
function kingsAreFacing(pos) {
  var rk = pos.kingPos[C.RED];
  var bk = pos.kingPos[C.BLACK];
  if (rk < 0 || bk < 0) return false;
  if (C.fileOf(rk) !== C.fileOf(bk)) return false;
  var board = pos.board;
  var lo = Math.min(rk, bk);
  var hi = Math.max(rk, bk);
  for (var i = lo + 1; i < hi; i++) {
    if (board[i] !== C.EMPTY) return false;
  }
  return true;
}

/**
 * 生成全部合法走法（排除走完后己方被将、以及造成将帅照面的走法）
 * @param {Position} pos
 * @param {number} [side] 默认为当前走子方
 * @returns {number[]} 打包走法数组
 */
function genLegalMoves(pos, side) {
  side = side === undefined ? pos.side : side;
  var out = [];
  genLegalMovesInPlace(pos, side, out, false, { from: 0, to: 0, piece: 0, captured: 0, side: 0 });
  return out;
}

/**
 * 生成合法走法并追加到扁平数组（供搜索复用以减少分配）
 * @returns {number} 本次生成走法在 out 中的起始下标
 */
function genLegalMovesInPlace(pos, side, out, capturesOnly, undo) {
  var start = out.length;
  genPseudoMoves(pos, side, out, capturesOnly);
  var write = start;
  for (var i = start; i < out.length; i++) {
    var m = out[i];
    var from = moveFrom(m);
    var to = moveTo(m);
    pos.makeMove(from, to, undo);
    var legal = !isChecked(pos, side);
    pos.unmakeMove(undo);
    if (legal) out[write++] = m;
  }
  out.length = write;
  return start;
}

/** 该方是否还有合法走法 */
function hasLegalMove(pos, side) {
  var moves = genLegalMoves(pos, side === undefined ? pos.side : side);
  return moves.length > 0;
}

/**
 * 校验一步棋是否合法（用于联机时校验对手/自己提交的走法）
 * @returns {boolean}
 */
function isMoveLegal(pos, side, from, to) {
  if (from < 0 || from >= C.BOARD_SIZE || to < 0 || to >= C.BOARD_SIZE) return false;
  if (from === to) return false;
  var piece = pos.board[from];
  if (piece === C.EMPTY) return false;
  if (C.sideOf(piece) !== side) return false;
  if (pos.board[to] !== C.EMPTY && C.sideOf(pos.board[to]) === side) return false;

  // 该走法必须能在伪合法列表中找到，且走完后己方不被将
  var probe = [];
  genPseudoMoves(pos, side, probe, false);
  var packed = packMove(from, to);
  if (probe.indexOf(packed) < 0) return false;

  var undo = { from: 0, to: 0, piece: 0, captured: 0, side: 0 };
  pos.makeMove(from, to, undo);
  var legal = !isChecked(pos, side);
  pos.unmakeMove(undo);
  return legal;
}

module.exports = {
  packMove: packMove,
  moveFrom: moveFrom,
  moveTo: moveTo,
  genPseudoMoves: genPseudoMoves,
  genLegalMoves: genLegalMoves,
  genLegalMovesInPlace: genLegalMovesInPlace,
  isChecked: isChecked,
  kingsAreFacing: kingsAreFacing,
  hasLegalMove: hasLegalMove,
  isMoveLegal: isMoveLegal
};
