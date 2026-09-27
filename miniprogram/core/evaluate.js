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

// ---------------------------------------------------------------------------
// 将帅安全
//
// 象棋里"将帅安全"不像国际象棋那样靠兵形，而是看**对方攻子离九宫有多近、
// 能不能直取**：沉底车、当头炮、卧槽马都是这个意思。这里用"攻子到对方将帅的
// 切比雪夫距离 + 是否同线（同线再加权、车无遮挡/炮有炮架才算真威胁）"来近似，
// 折进位置价值那一趟扫描里算，不额外增加棋盘遍历。
// ---------------------------------------------------------------------------

/** 各兵种逼近对方九宫的基础威胁值（按棋子类型索引：4 马 / 5 车 / 6 炮 / 7 兵） */
var KING_THREAT = [0, 0, 0, 0, 14, 26, 20, 8];

/** 攻子离对方将帅多远以内才算威胁 */
var KING_THREAT_RANGE = 3;

// ---------------------------------------------------------------------------
// 机动性 / 子力协调
//
// 象棋里"子力互相堵塞"是很实在的弱点：马腿被塞住，那个方向的两个落点直接废掉；
// 车炮被自家子堵在角落里，摆着却发挥不出作用。这里用很便宜的方式近似：
//   · 马：四个马腿各看一格，被占则该方向作废 → 扣分
//   · 车/炮：沿四个方向数空格，每方向最多数 MOBILITY_CAP 格 → 加分
// 只数前几格是有意的——评估在每个叶子节点都要跑，为了"精确机动性"遍历整条线不值。
// ---------------------------------------------------------------------------

/** 每个可走空格的分值 */
var MOBILITY_UNIT = 2;
/** 每个方向最多数几格 */
var MOBILITY_CAP = 3;
/** 每个被塞住的马腿折算成几格机动性 */
var HORSE_LEG_BLOCKED = 3;

/**
 * 数 (from, to) 之间（不含两端）有几个子：车要 0 个才直取，炮要恰好 1 个当炮架
 * @param {Array<number>} board
 * @param {number} from
 * @param {number} to 与 from 同一列或同一行
 * @param {number} step 同列传 C.FILES，同行传 1（idx 布局：rank * FILES + file）
 */
function countBlockers(board, from, to, step) {
  var s = to > from ? step : -step;
  var n = 0;
  for (var i = from + s; i !== to; i += s) {
    if (board[i] !== C.EMPTY) n++;
  }
  return n;
}

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
  var redRook = 0, redCannon = 0, redAdvisor = 0, redBishop = 0;
  var blackRook = 0, blackCannon = 0, blackAdvisor = 0, blackBishop = 0;
  var i, piece, type, value;

  // 第一趟：子力价值，顺带数各兵种（"缺士怕车、缺象怕炮"要用）
  for (i = 0; i < C.BOARD_SIZE; i++) {
    piece = board[i];
    if (piece === C.EMPTY) continue;
    type = piece > 0 ? piece : -piece;
    if (type === 1) continue; // 将帅价值不计入子力统计
    value = PIECE_VALUE[type];
    if (piece > 0) {
      redMaterial += value;
      if (type === 5) redRook++;
      else if (type === 6) redCannon++;
      else if (type === 2) redAdvisor++;
      else if (type === 3) redBishop++;
    } else {
      blackMaterial += value;
      if (type === 5) blackRook++;
      else if (type === 6) blackCannon++;
      else if (type === 2) blackAdvisor++;
      else if (type === 3) blackBishop++;
    }
  }

  // 残局系数 0~1：子力越少，兵（卒）与将帅活动性的权重越高
  var totalMaterial = redMaterial + blackMaterial;
  var endgame = totalMaterial >= ENDGAME_MATERIAL
    ? 0
    : (ENDGAME_MATERIAL - totalMaterial) / ENDGAME_MATERIAL;

  var redKing = pos.kingPos[C.RED];
  var blackKing = pos.kingPos[C.BLACK];
  var redThreat = 0;    // 红方攻子对黑方九宫的威胁
  var blackThreat = 0;  // 黑方攻子对红方九宫的威胁

  // 第二趟：位置价值 + 攻子逼近对方九宫
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

    // 机动性 / 子力堵塞：马腿被占、车炮的路被自家子挡住
    if (type >= 4 && type <= 6) {
      var pf = C.fileOf(i);
      var pr = C.rankOf(i);
      var mob = 0;
      if (type === 4) {
        if (pf > 0 && board[C.idxOf(pf - 1, pr)] !== C.EMPTY) mob -= HORSE_LEG_BLOCKED;
        if (pf < 8 && board[C.idxOf(pf + 1, pr)] !== C.EMPTY) mob -= HORSE_LEG_BLOCKED;
        if (pr > 0 && board[C.idxOf(pf, pr - 1)] !== C.EMPTY) mob -= HORSE_LEG_BLOCKED;
        if (pr < 9 && board[C.idxOf(pf, pr + 1)] !== C.EMPTY) mob -= HORSE_LEG_BLOCKED;
      } else {
        var rays = C.RAY_DIRS[i];
        for (var rd = 0; rd < 4; rd++) {
          var ray = rays[rd];
          var lim = ray.length < MOBILITY_CAP ? ray.length : MOBILITY_CAP;
          for (var rk = 0; rk < lim; rk++) {
            if (board[ray[rk]] !== C.EMPTY) break;
            mob++;
          }
        }
      }
      if (mob !== 0) score += piece > 0 ? mob * MOBILITY_UNIT : -mob * MOBILITY_UNIT;
    }

    // 攻子威胁对方九宫：分两种情形
    //   ① 同一列/同一行——车无遮挡、炮有炮架就能直取将帅（沉底车、当头炮），
    //      距离再远也是真威胁，给双倍权重；被挡住则减半。
    //   ② 不在同一线——只有靠近（切比雪夫距离 ≤ 3）才算威胁（卧槽马、近身车炮）。
    if (type >= 4 && type <= 7) {
      var foeKing = piece > 0 ? blackKing : redKing;
      if (foeKing >= 0) {
        var df = C.fileOf(i) - C.fileOf(foeKing);
        var dr = C.rankOf(i) - C.rankOf(foeKing);
        if (df < 0) df = -df;
        if (dr < 0) dr = -dr;
        var near = df > dr ? df : dr;
        var w = 0;
        if (df === 0 || dr === 0) {
          var blockers = countBlockers(board, i, foeKing, df === 0 ? C.FILES : 1);
          if (type === 5) w = blockers === 0 ? KING_THREAT[5] * 2 : KING_THREAT[5] >> 1;
          else if (type === 6) w = blockers === 1 ? KING_THREAT[6] * 2 : KING_THREAT[6] >> 1;
          else w = near <= 2 ? KING_THREAT[type] : KING_THREAT[type] >> 1;
        } else if (near <= KING_THREAT_RANGE) {
          w = near <= 1 ? (KING_THREAT[type] * 3) >> 1 : KING_THREAT[type];
        }
        if (w > 0) {
          if (piece > 0) redThreat += w; else blackThreat += w;
        }
      }
    }
  }
  score += redThreat - blackThreat;

  // 缺士怕车、缺象怕炮：士象的价值取决于对方还有多少攻击子力。
  // 一个士对上一门车才值钱，双方都剩单车寡炮时缺士象并不致命。
  score -= (2 - redAdvisor) * (blackRook * 50 + blackCannon * 15);
  score -= (2 - redBishop) * (blackCannon * 35 + blackRook * 15);
  score += (2 - blackAdvisor) * (redRook * 50 + redCannon * 15);
  score += (2 - blackBishop) * (redCannon * 35 + redRook * 15);

  return score;
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
