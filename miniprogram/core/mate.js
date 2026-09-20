/**
 * 杀法识别（绝杀命名）
 *
 * 输入一个「已经走完最后一步」的局面，判断这盘棋的杀法叫什么名字。
 * 只覆盖**名字由终局几何唯一决定**的那一类——名字本身就是在描述终局形态，
 * 所以判得出来；至于「大胆穿心」「炮碾丹砂」这类描述攻杀过程的名字，
 * 终局里已经没有任何信息可以还原，一律不猜（返回 null）。
 *
 * 判据用到的坐标记法（攻击方看「路」，防守方看「横线」）：
 *   路   = 攻击方纵线编号：红攻黑时 路 = 9 - file；黑攻红时 路 = file + 1
 *   横线 = 防守方横线编号：黑守时 横线 = rank + 1；红守时 横线 = 10 - rank
 * 据此马位术语都是精确格位，例如卧槽马 = 路3/7 × 横线2 = (2,1)/(6,1)。
 *
 * 纯 JavaScript，不依赖 wx，可在 node 下单测。
 */

var C = require('./constants.js');
var MG = require('./movegen.js');

/** 棋子类型（绝对值）：车 5 / 炮 6 / 马 4 / 兵 7 / 士 2 */
var ROOK = 5;
var CANNON = 6;
var KNIGHT = 4;
var PAWN = 7;
var ADVISOR = 2;

/**
 * 本模块认得的全部杀法
 *
 * key 是稳定的 ASCII 标识，供语音文件名等外部资源引用——不随中文名改动而变。
 *
 * speech 是给语音合成用的**同音替代文本**，只在朗读时生效，显示仍然是 name。
 * 中文里多音字很多，TTS 会挑最常用的读音，象棋术语常常不是那一个：
 *   重炮 -> 读 chóng（叠炮、两炮并线），不是 zhòng
 *   双车错 -> 车在象棋里读 jū，不是 chē
 * 用同音字「按构造」锁死读音，比依赖 TTS 的上下文判断可靠。
 */
var MATE_PATTERNS = [
  { key: 'duimianxiao', name: '对面笑' },
  { key: 'mahoupao', name: '马后炮' },
  { key: 'chongpao', name: '重炮', speech: '虫炮' },
  { key: 'mengong', name: '闷宫' },
  { key: 'shuangchecuo', name: '双车错', speech: '双居错' },
  { key: 'wocaoma', name: '卧槽马' },
  { key: 'guajiaoma', name: '挂角马' },
  { key: 'diaoyuma', name: '钓鱼马' },
  { key: 'cemianhu', name: '侧面虎' },
  { key: 'erguipaimen', name: '二鬼拍门' },
  { key: 'mensha', name: '闷杀' }
];

var BY_KEY = {};
MATE_PATTERNS.forEach(function (p) { BY_KEY[p.key] = p.name; });

/**
 * 组装识别结果
 *
 * 除名字外还带回**演出需要的几何**，让绝杀动画可以数据驱动地画出来：
 *   checker 将军子索引（将帅照面时为 null）
 *   screen  炮架索引（非炮系为 null）
 *   king    被将方的将/帅索引
 *   pieces  构成这个杀法的棋子索引（用于高亮"是哪几枚杀死的"）
 */
function pattern(key, why, geo) {
  var out = { key: key, name: BY_KEY[key], why: why, checker: null, screen: null, king: null, pieces: [] };
  if (geo) {
    for (var k in geo) {
      if (Object.prototype.hasOwnProperty.call(geo, k)) out[k] = geo[k];
    }
  }
  return out;
}

function abs(v) { return v > 0 ? v : -v; }

// ---------------------------------------------------------------------------
// 几何工具
// ---------------------------------------------------------------------------

/**
 * 同一直线上两点之间（不含端点）的全部格子
 * @returns {?number[]} 不在同一条直线（同一行或同一列）时返回 null
 */
function between(a, b) {
  var fa = C.fileOf(a), ra = C.rankOf(a);
  var fb = C.fileOf(b), rb = C.rankOf(b);
  var out = [];
  var i, lo, hi;

  if (fa === fb) {
    lo = Math.min(ra, rb) + 1;
    hi = Math.max(ra, rb);
    for (i = lo; i < hi; i++) out.push(C.idxOf(fa, i));
    return out;
  }
  if (ra === rb) {
    lo = Math.min(fa, fb) + 1;
    hi = Math.max(fa, fb);
    for (i = lo; i < hi; i++) out.push(C.idxOf(i, ra));
    return out;
  }
  return null;
}

/**
 * 正在将军的棋子索引（可能不止一枚）
 *
 * 用「攻击方的合法走法里，终点是被将方将/帅」来反查——这样被牵制的子
 * 不会被误判成将军子。
 */
function findCheckers(pos, atkSide) {
  var kingIdx = pos.kingPos[1 - atkSide];
  if (kingIdx < 0) return [];

  var moves = MG.genLegalMoves(pos, atkSide);
  var seen = {};
  var out = [];
  for (var i = 0; i < moves.length; i++) {
    var from = MG.moveFrom(moves[i]);
    if (MG.moveTo(moves[i]) !== kingIdx) continue;
    if (seen[from]) continue;
    seen[from] = 1;
    out.push(from);
  }
  return out;
}

/** 某一方指定类型的棋子位置 */
function piecesOf(pos, side, type) {
  var out = [];
  for (var i = 0; i < C.BOARD_SIZE; i++) {
    var p = pos.board[i];
    if (p === C.EMPTY) continue;
    if (C.sideOf(p) !== side) continue;
    if (type !== undefined && abs(p) !== type) continue;
    out.push(i);
  }
  return out;
}

/** 车能否攻击到某格（中间无子即可，车不需要炮架） */
function rookAttacks(board, from, to) {
  var line = between(from, to);
  if (!line) return false;
  for (var i = 0; i < line.length; i++) {
    if (board[line[i]] !== C.EMPTY) return false;
  }
  return true;
}

/** 将/帅的相邻格（含九宫约束之外的过滤交给调用方） */
function kingNeighbors(kingIdx) {
  var f = C.fileOf(kingIdx), r = C.rankOf(kingIdx);
  var cand = [[f - 1, r], [f + 1, r], [f, r - 1], [f, r + 1]];
  var out = [];
  for (var i = 0; i < cand.length; i++) {
    var cf = cand[i][0], cr = cand[i][1];
    if (cf < 0 || cf > C.FILES - 1 || cr < 0 || cr > C.RANKS - 1) continue;
    out.push(C.idxOf(cf, cr));
  }
  return out;
}

/**
 * 马位术语：由「路 × 横线」查名字
 * @returns {?string} 不在任何有名格位上时返回 null
 */
function horseTerm(file, rank, atkSide, defSide) {
  var lu = atkSide === C.RED ? 9 - file : file + 1;
  var heng = defSide === C.BLACK ? rank + 1 : 10 - rank;

  if (lu === 2 || lu === 8) return heng === 2 ? '金钩马' : null;
  if (lu === 4 || lu === 6) {
    if (heng === 1) return '将边马';
    if (heng === 3) return '挂角马';
    return null;
  }
  if (lu === 5) {
    if (heng === 2) return '窝心马';
    if (heng === 3) return '宫顶马';
    return null;
  }
  if (lu === 3 || lu === 7) {
    if (heng === 2) return '卧槽马';
    if (heng === 3) return '钓鱼马';
    if (heng === 4) return '侧面虎';
  }
  return null;
}

/** 马位术语 -> 杀法 key（只有这四种是标准杀法名） */
var HORSE_MATE_KEY = {
  '卧槽马': 'wocaoma',
  '挂角马': 'guajiaoma',
  '钓鱼马': 'diaoyuma',
  '侧面虎': 'cemianhu'
};

/** 两格是否正交相邻（上下左右紧贴） */
function isAdjacent(a, b) {
  return Math.abs(C.fileOf(a) - C.fileOf(b)) + Math.abs(C.rankOf(a) - C.rankOf(b)) === 1;
}

/** 将的每个可走相邻格是否都被自己人占着（走不动 = 被自家子堵死） */
function selfBlocked(pos, defSide, kingIdx) {
  var neighbors = kingNeighbors(kingIdx);
  var any = false;
  for (var i = 0; i < neighbors.length; i++) {
    var idx = neighbors[i];
    var f = C.fileOf(idx), r = C.rankOf(idx);
    // 将只能在九宫内走
    if (!C.inPalace(f, r, defSide)) continue;
    any = true;
    var p = pos.board[idx];
    if (p === C.EMPTY || C.sideOf(p) !== defSide) return false;
  }
  return any;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 识别杀法
 *
 * @param {Position} pos 已经走完最后一步的局面
 * @param {number} atkSide 胜方（正在将军的一方）
 * @returns {?{key:string, name:string, why:string}} 认不出时返回 null
 */
function classifyMate(pos, atkSide) {
  var defSide = 1 - atkSide;
  var kingIdx = pos.kingPos[defSide];
  if (kingIdx < 0 || !pos.board) return null;

  var board = pos.board;
  var checkers = findCheckers(pos, atkSide);

  // 1) 将帅照面：没有任何子力将军，唯一的将军来源就是「帅/将」本身
  if (!checkers.length) {
    if (MG.kingsAreFacing(pos)) {
      var rk = pos.kingPos[atkSide];
      var bk = pos.kingPos[defSide];
      return pattern('duimianxiao', '将帅照面，帅（将）本身封死退路',
        { king: kingIdx, pieces: [rk, bk] });
    }
    return null;
  }

  // 2) 逐枚将军子匹配。顺序即优先级：越具体的形态越先判
  for (var i = 0; i < checkers.length; i++) {
    var from = checkers[i];
    var type = abs(board[from]);
    var hit = null;

    if (type === CANNON) hit = cannonMate(pos, atkSide, kingIdx, from);
    else if (type === KNIGHT) hit = knightMate(from, atkSide, defSide, kingIdx);
    else if (type === ROOK) hit = rookMate(pos, atkSide, kingIdx, from);

    if (hit) return hit;
  }

  // 3) 二鬼拍门：双兵分占两条肋道锁死九宫，将军子可以是别的子力
  var wings = pawnsOnWings(pos, atkSide, defSide);
  if (wings) {
    return pattern('erguipaimen', '双兵分占两条肋道，锁死九宫',
      { checker: checkers[0], king: kingIdx, pieces: wings });
  }

  // 4) 兜底：将的退路全被自家子占着
  if (selfBlocked(pos, defSide, kingIdx)) {
    return pattern('mensha', '将的退路被自家子堵死',
      { checker: checkers[0], king: kingIdx, pieces: [checkers[0]] });
  }

  return null;
}

/**
 * 炮系杀法：看炮架是谁
 *
 * 炮架是己方马 -> 马后炮；己方炮 -> 重炮。
 *
 * 炮架是敌子时，按「闷宫 / 闷杀」的定义细分（据百度百科「闷宫」词条）：
 *   闷宫 —— 炮架**一定是敌方的士**，且将紧贴炮架；对方因自家子阻碍动弹不得
 *   闷杀 —— 炮架是士以外的其他子力，或将已离开原位
 * 两者常合称「闷将杀」，但炮架是不是士这条界线很清楚。
 */
function cannonMate(pos, atkSide, kingIdx, from) {
  var line = between(from, kingIdx);
  if (!line) return null;

  var board = pos.board;
  var screens = [];
  for (var i = 0; i < line.length; i++) {
    if (board[line[i]] !== C.EMPTY) screens.push(line[i]);
  }
  // 将军成立的必要条件：炮与将之间恰好一个子
  if (screens.length !== 1) return null;

  var scr = screens[0];
  var scrPiece = board[scr];

  if (C.sideOf(scrPiece) === atkSide) {
    var t = abs(scrPiece);
    if (t === KNIGHT) {
      return pattern('mahoupao', '炮以己方马为架',
        { checker: from, screen: scr, king: kingIdx, pieces: [from, scr] });
    }
    if (t === CANNON) {
      return pattern('chongpao', '两炮并线，以己方炮为架',
        { checker: from, screen: scr, king: kingIdx, pieces: [from, scr] });
    }
    return null;
  }

  // 炮架是敌子
  if (abs(scrPiece) === ADVISOR && isAdjacent(scr, kingIdx)) {
    return pattern('mengong', '炮以敌方士为架，将紧贴炮架被堵死',
      { checker: from, screen: scr, king: kingIdx, pieces: [from, scr] });
  }
  return pattern('mensha', '炮借敌子为架，将被自家子堵死',
    { checker: from, screen: scr, king: kingIdx, pieces: [from, scr] });
}

/** 马系杀法：由落点的马位术语决定 */
function knightMate(from, atkSide, defSide, kingIdx) {
  var term = horseTerm(C.fileOf(from), C.rankOf(from), atkSide, defSide);
  var key = term ? HORSE_MATE_KEY[term] : null;
  if (!key) return null;
  return pattern(key, '马踏' + term + '位',
    { checker: from, king: kingIdx, pieces: [from] });
}

/**
 * 车系杀法：另一车必须真的参与封口
 *
 * 只数「还有一车」会把单车杀误判成双车错，所以要求另一车确实攻击将的某个
 * 相邻格——它才是把退路封住的那一车。
 */
function rookMate(pos, atkSide, kingIdx, from) {
  var board = pos.board;
  var others = piecesOf(pos, atkSide, ROOK).filter(function (r) { return r !== from; });
  if (!others.length) return null;

  var around = kingNeighbors(kingIdx);
  for (var i = 0; i < others.length; i++) {
    for (var j = 0; j < around.length; j++) {
      if (rookAttacks(board, others[i], around[j])) {
        return pattern('shuangchecuo', '一车将军，另一车封住将的退路',
          { checker: from, king: kingIdx, pieces: [from, others[i]] });
      }
    }
  }
  return null;
}

/**
 * 二鬼拍门
 *
 * 判据取最不含糊的形态——两只兵都进了九宫，且分别占住 3 路与 5 路两条肋道，
 * 把将的左右退路连同九宫前沿一起锁死。将军子可以是别的子力（定义即
 * 「锁住两条肋道，再借其他子力配合攻击」），所以不要求将军子是兵。
 *
 * @returns {?number[]} 两条肋道上的兵，不构成时返回 null
 */
function pawnsOnWings(pos, atkSide, defSide) {
  var pawns = piecesOf(pos, atkSide, PAWN).filter(function (p) {
    return C.inPalace(C.fileOf(p), C.rankOf(p), defSide);
  });
  if (pawns.length < 2) return null;

  var onFile3 = null;
  var onFile5 = null;
  for (var i = 0; i < pawns.length; i++) {
    var f = C.fileOf(pawns[i]);
    if (f === 3 && onFile3 === null) onFile3 = pawns[i];
    if (f === 5 && onFile5 === null) onFile5 = pawns[i];
  }
  if (onFile3 === null || onFile5 === null) return null;
  return [onFile3, onFile5];
}

module.exports = classifyMate;
module.exports.classifyMate = classifyMate;
module.exports.MATE_PATTERNS = MATE_PATTERNS;
module.exports.between = between;
module.exports.horseTerm = horseTerm;
