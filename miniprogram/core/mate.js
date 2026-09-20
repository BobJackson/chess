/**
 * 杀法识别（绝杀命名）
 *
 * 输入一个「已经走完最后一步」的局面，判断这盘棋的杀法叫什么名字。
 *
 * 认得 15 种，分两类：
 *   几何型（11）—— 名字描述终局形态，判据唯一：对面笑、马后炮、重炮、闷宫、
 *                  双车错、卧槽马、挂角马、钓鱼马、侧面虎、二鬼拍门、闷杀
 *   阵形型（4） —— 名字描述攻杀阵形，天然会与几何型重叠：天地炮、夹车炮、
 *                  铁门栓、海底捞月
 *
 * 两类都不认的，是名字描述「过程」或「威胁」的那些：「大胆穿心」「炮碾丹砂」讲的是
 * 怎么杀的，「空头炮」讲的是一个阵形威胁（详见下文 matchKongtoupao 处的说明）——
 * 终局里都已无从还原，一律不猜。
 *
 * ── 撞名怎么解 ──
 * 阵形型与几何型会重叠（同一个终局既像闷宫又像天地炮）。解法不是拍一张优先级表，
 * 而是给判据补上**区分性条件**，让每种各归各位：
 *   闷宫要求「**单炮**将军」——两炮同时将军是天地炮，不是闷宫
 *   重炮要求「**无车参与**」——有车参与封口就是夹车炮
 * 剩下少量顺序依赖，用 MATCHERS 的排列显式表达：越具体的排越前。
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

/** 棋子类型（绝对值）：士 2 / 马 4 / 车 5 / 炮 6 / 兵 7 */
var ADVISOR = 2;
var KNIGHT = 4;
var ROOK = 5;
var CANNON = 6;
var PAWN = 7;

/**
 * 本模块认得的全部杀法
 *
 * key 是稳定的 ASCII 标识，供语音文件名等外部资源引用——不随中文名改动而变。
 *
 * speech 是给语音合成用的**同音替代文本**，只在朗读时生效，显示仍然是 name。
 * 中文里多音字很多，TTS 会挑最常用的读音，象棋术语常常不是那一个：
 *   重炮 -> 读 chóng（叠炮、两炮并线），不是 zhòng
 *   双车错 / 夹车炮 -> 车在象棋里读 jū，不是 chē
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
  { key: 'mensha', name: '闷杀' },
  { key: 'tiandipao', name: '天地炮' },
  { key: 'jiachepao', name: '夹车炮', speech: '夹居炮' },
  { key: 'tiemenshuan', name: '铁门栓' },
  { key: 'haidilaoyue', name: '海底捞月' }
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

/** 两格是否正交相邻（上下左右紧贴） */
function isAdjacent(a, b) {
  return Math.abs(C.fileOf(a) - C.fileOf(b)) + Math.abs(C.rankOf(a) - C.rankOf(b)) === 1;
}

/** 将/帅的相邻格 */
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

/**
 * 马的方位术语：由「路 × 横线」查名字
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

// ---------------------------------------------------------------------------
// 局面查询：判据的共用底座
// ---------------------------------------------------------------------------

/**
 * 炮与将之间恰好一个子时返回该子的索引，否则返回 -1
 *
 * 这是炮能将军的必要条件，多个炮系判据都以它起步。
 */
function cannonScreen(ctx, cannonIdx) {
  var line = between(cannonIdx, ctx.kingIdx);
  if (!line) return -1;
  var found = -1;
  for (var i = 0; i < line.length; i++) {
    if (ctx.board[line[i]] === C.EMPTY) continue;
    if (found >= 0) return -1;
    found = line[i];
  }
  return found;
}

/** 正在将军的炮有几门（闷宫要求「单炮」） */
function cannonsChecking(ctx) {
  var n = 0;
  for (var i = 0; i < ctx.checkers.length; i++) {
    if (abs(ctx.board[ctx.checkers[i]]) === CANNON) n++;
  }
  return n;
}

/**
 * 己方是否有车参与封口（攻击将的某个相邻格）
 * @returns {number} 车的位置，没有则 -1
 */
function rookInNet(ctx) {
  var rooks = piecesOf(ctx.pos, ctx.atkSide, ROOK);
  var around = kingNeighbors(ctx.kingIdx);
  for (var i = 0; i < rooks.length; i++) {
    for (var j = 0; j < around.length; j++) {
      if (rookAttacks(ctx.board, rooks[i], around[j])) return rooks[i];
    }
  }
  return -1;
}

/** 将的每个可走相邻格是否都被自己人占着（走不动 = 被自家子堵死） */
function selfBlocked(ctx) {
  var neighbors = kingNeighbors(ctx.kingIdx);
  var any = false;
  for (var i = 0; i < neighbors.length; i++) {
    var idx = neighbors[i];
    if (!C.inPalace(C.fileOf(idx), C.rankOf(idx), ctx.defSide)) continue;
    any = true;
    var p = ctx.board[idx];
    if (p === C.EMPTY || C.sideOf(p) !== ctx.defSide) return false;
  }
  return any;
}

/** 防守方的底线 */
function backRankOf(defSide) {
  return defSide === C.BLACK ? 0 : C.RANKS - 1;
}

/** 第一枚将军子（用于「随便哪个将军子」的判据） */
function firstChecker(ctx) {
  return ctx.checkers.length ? ctx.checkers[0] : null;
}

// ---------------------------------------------------------------------------
// 各杀法的判据：每条只回答「是不是我」
// ---------------------------------------------------------------------------

/** 对面笑：没有任何子力将军，唯一的将军来源就是「帅/将」本身 */
function matchDuimianxiao(ctx) {
  if (ctx.checkers.length) return null;
  if (!MG.kingsAreFacing(ctx.pos)) return null;
  return pattern('duimianxiao', '将帅照面，帅（将）本身封死退路', {
    king: ctx.kingIdx,
    pieces: [ctx.pos.kingPos[ctx.atkSide], ctx.kingIdx]
  });
}

/** 马后炮：炮的炮架是己方马 */
function matchMahoupao(ctx) {
  for (var i = 0; i < ctx.checkers.length; i++) {
    var from = ctx.checkers[i];
    if (abs(ctx.board[from]) !== CANNON) continue;
    var scr = cannonScreen(ctx, from);
    if (scr < 0) continue;
    if (C.sideOf(ctx.board[scr]) !== ctx.atkSide) continue;
    if (abs(ctx.board[scr]) !== KNIGHT) continue;
    return pattern('mahoupao', '炮以己方马为架', {
      checker: from, screen: scr, king: ctx.kingIdx, pieces: [from, scr]
    });
  }
  return null;
}

/** 马系：由落点的马位术语决定（格位唯一，不会与别的判据混淆） */
function matchKnight(ctx) {
  for (var i = 0; i < ctx.checkers.length; i++) {
    var from = ctx.checkers[i];
    if (abs(ctx.board[from]) !== KNIGHT) continue;
    var term = horseTerm(C.fileOf(from), C.rankOf(from), ctx.atkSide, ctx.defSide);
    var key = term ? HORSE_MATE_KEY[term] : null;
    if (!key) continue;
    return pattern(key, '马踏' + term + '位', {
      checker: from, king: ctx.kingIdx, pieces: [from]
    });
  }
  return null;
}

/**
 * 闷宫：炮架是**敌方的士**、将紧贴炮架，且是**单炮**将军
 *
 * 「单炮」这条区分性条件很关键：两炮同时将军是天地炮，不该叫闷宫。
 */
function matchMengong(ctx) {
  if (cannonsChecking(ctx) !== 1) return null;
  for (var i = 0; i < ctx.checkers.length; i++) {
    var from = ctx.checkers[i];
    if (abs(ctx.board[from]) !== CANNON) continue;
    var scr = cannonScreen(ctx, from);
    if (scr < 0) continue;
    if (C.sideOf(ctx.board[scr]) === ctx.atkSide) continue;
    if (abs(ctx.board[scr]) !== ADVISOR) continue;
    if (!isAdjacent(scr, ctx.kingIdx)) continue;
    return pattern('mengong', '炮以敌方士为架，将紧贴炮架被堵死', {
      checker: from, screen: scr, king: ctx.kingIdx, pieces: [from, scr]
    });
  }
  return null;
}

/**
 * 重炮：炮架是己方炮，且**没有车参与**封口
 *
 * 「无车参与」用来把夹车炮让出来——双炮并线时若还有车配合，那是夹车炮。
 */
function matchChongpao(ctx) {
  if (rookInNet(ctx) >= 0) return null;
  for (var i = 0; i < ctx.checkers.length; i++) {
    var from = ctx.checkers[i];
    if (abs(ctx.board[from]) !== CANNON) continue;
    var scr = cannonScreen(ctx, from);
    if (scr < 0) continue;
    if (C.sideOf(ctx.board[scr]) !== ctx.atkSide) continue;
    if (abs(ctx.board[scr]) !== CANNON) continue;
    return pattern('chongpao', '两炮并线，以己方炮为架', {
      checker: from, screen: scr, king: ctx.kingIdx, pieces: [from, scr]
    });
  }
  return null;
}

/** 闷杀：炮架是士以外的敌子（士做架且将紧贴已归闷宫） */
function matchMensha(ctx) {
  for (var i = 0; i < ctx.checkers.length; i++) {
    var from = ctx.checkers[i];
    if (abs(ctx.board[from]) !== CANNON) continue;
    var scr = cannonScreen(ctx, from);
    if (scr < 0) continue;
    if (C.sideOf(ctx.board[scr]) === ctx.atkSide) continue;
    return pattern('mensha', '炮借敌子为架，将被自家子堵死', {
      checker: from, screen: scr, king: ctx.kingIdx, pieces: [from, scr]
    });
  }
  return null;
}

/** 铁门栓：中炮（在将的纵线上）+ 车或兵占住将门（将正前方那格）将军 */
function matchTiemenshuan(ctx) {
  var kingFile = C.fileOf(ctx.kingIdx);
  var middles = piecesOf(ctx.pos, ctx.atkSide, CANNON).filter(function (c) {
    return C.fileOf(c) === kingFile;
  });
  if (!middles.length) return null;

  var doorRank = C.rankOf(ctx.kingIdx) + (ctx.defSide === C.BLACK ? 1 : -1);
  if (doorRank < 0 || doorRank > C.RANKS - 1) return null;
  var door = C.idxOf(kingFile, doorRank);

  var p = ctx.board[door];
  if (p === C.EMPTY || C.sideOf(p) !== ctx.atkSide) return null;
  var t = abs(p);
  if (t !== ROOK && t !== PAWN) return null;
  if (ctx.checkers.indexOf(door) < 0) return null;

  return pattern('tiemenshuan', '中炮镇中路，车（兵）封住将门', {
    checker: door, king: ctx.kingIdx, pieces: [door, middles[0]]
  });
}

/** 海底捞月：将军子沉在对方底线、正对将的背后（将本身不在底线） */
function matchHaidilaoyue(ctx) {
  var back = backRankOf(ctx.defSide);
  if (C.rankOf(ctx.kingIdx) === back) return null;
  var kingFile = C.fileOf(ctx.kingIdx);
  for (var i = 0; i < ctx.checkers.length; i++) {
    var c = ctx.checkers[i];
    if (C.rankOf(c) === back && C.fileOf(c) === kingFile) {
      return pattern('haidilaoyue', '子力沉底，在将的背后发起攻击', {
        checker: c, king: ctx.kingIdx, pieces: [c]
      });
    }
  }
  return null;
}

/** 天地炮：中炮（天炮）在将的纵线 + 沉底炮（地炮）在对方底线 */
function matchTiandipao(ctx) {
  var cannons = piecesOf(ctx.pos, ctx.atkSide, CANNON);
  if (cannons.length < 2) return null;

  var back = backRankOf(ctx.defSide);
  var kingFile = C.fileOf(ctx.kingIdx);
  var middle = -1, bottom = -1;
  for (var i = 0; i < cannons.length; i++) {
    if (middle < 0 && C.fileOf(cannons[i]) === kingFile) middle = cannons[i];
    if (bottom < 0 && C.rankOf(cannons[i]) === back) bottom = cannons[i];
  }
  if (middle < 0 || bottom < 0 || middle === bottom) return null;
  if (ctx.checkers.indexOf(middle) < 0 && ctx.checkers.indexOf(bottom) < 0) return null;

  return pattern('tiandipao', '中炮（天炮）镇中路，沉底炮（地炮）控底线', {
    checker: middle, king: ctx.kingIdx, pieces: [middle, bottom]
  });
}

/** 夹车炮：双炮并线，且有车参与封口 */
function matchJiachepao(ctx) {
  var cannons = piecesOf(ctx.pos, ctx.atkSide, CANNON);
  if (cannons.length < 2) return null;

  var pair = null;
  for (var i = 0; i < cannons.length && !pair; i++) {
    for (var j = i + 1; j < cannons.length; j++) {
      if (between(cannons[i], cannons[j])) { pair = [cannons[i], cannons[j]]; break; }
    }
  }
  if (!pair) return null;

  var rk = rookInNet(ctx);
  if (rk < 0) return null;
  if (ctx.checkers.indexOf(pair[0]) < 0 && ctx.checkers.indexOf(pair[1]) < 0) return null;

  return pattern('jiachepao', '双炮并线，与车交替配合', {
    checker: pair[0], king: ctx.kingIdx, pieces: [pair[0], pair[1], rk]
  });
}

/*
 * ── 为什么不认「空头炮」──
 *
 * 空头炮（炮与将同一直线、中间无子）**只是个威胁，本身不构成绝杀**：
 * 炮要炮架才能吃子，没有炮架它既将军不了、也封不住任何格子，在终局里是个旁观者。
 *
 * 实测过：拿一个「车沿底线将军 + 马封中格」的将死局面，把那门空头炮**整枚拿掉，
 * 局面照样是将死**——说明它没有参与这一杀。给一个没参与的棋子命名，正是
 * 「宁可少说不能说错」要避免的，所以这里不给它判据。
 *
 * 这与「天地炮」等其余四种阵形型的区别正在于此：那四种的棋子都实打实地参与杀
 * （两炮都在将军 / 车真的封了口 / 中炮正是士不敢吃车的原因 / 将军子确实沉在底线），
 * 所以它们能命名；空头炮不能。
 */

/** 双车错：另一车确实参与封口（攻击将的相邻格） */
function matchShuangchecuo(ctx) {
  for (var i = 0; i < ctx.checkers.length; i++) {
    var from = ctx.checkers[i];
    if (abs(ctx.board[from]) !== ROOK) continue;
    var others = piecesOf(ctx.pos, ctx.atkSide, ROOK).filter(function (r) { return r !== from; });
    var around = kingNeighbors(ctx.kingIdx);
    for (var a = 0; a < others.length; a++) {
      for (var b = 0; b < around.length; b++) {
        if (rookAttacks(ctx.board, others[a], around[b])) {
          return pattern('shuangchecuo', '一车将军，另一车封住将的退路', {
            checker: from, king: ctx.kingIdx, pieces: [from, others[a]]
          });
        }
      }
    }
  }
  return null;
}

/**
 * 二鬼拍门：双兵都进了九宫，且分别占住 3 路与 5 路两条肋道
 *
 * 将军子可以是别的子力（定义即「锁住两条肋道，再借其他子力配合攻击」），
 * 所以不要求将军子是兵。
 */
function matchErguipaimen(ctx) {
  var pawns = piecesOf(ctx.pos, ctx.atkSide, PAWN).filter(function (p) {
    return C.inPalace(C.fileOf(p), C.rankOf(p), ctx.defSide);
  });
  if (pawns.length < 2) return null;

  var onFile3 = -1, onFile5 = -1;
  for (var i = 0; i < pawns.length; i++) {
    var f = C.fileOf(pawns[i]);
    if (f === 3 && onFile3 < 0) onFile3 = pawns[i];
    if (f === 5 && onFile5 < 0) onFile5 = pawns[i];
  }
  if (onFile3 < 0 || onFile5 < 0) return null;

  return pattern('erguipaimen', '双兵分占两条肋道，锁死九宫', {
    checker: firstChecker(ctx), king: ctx.kingIdx, pieces: [onFile3, onFile5]
  });
}

/** 兜底：将的退路全被自家子占着 */
function matchSelfBlocked(ctx) {
  if (!selfBlocked(ctx)) return null;
  return pattern('mensha', '将的退路被自家子堵死', {
    checker: firstChecker(ctx), king: ctx.kingIdx, pieces: [firstChecker(ctx)]
  });
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 匹配器链：**顺序即优先级，越具体的排越前**
 *
 * 前 5 条都带唯一性条件（马位格位、单炮、无车参与等），彼此不重叠；
 * 中段是阵形型（铁门栓/海底捞月/天地炮/夹车炮/空头炮），它们比「双车错」
 * 这类只靠「另一子参与封口」的松判据更具体，所以排在前面。
 */
var MATCHERS = [
  matchDuimianxiao,
  matchMahoupao,
  matchKnight,
  matchMengong,
  matchChongpao,
  matchTiemenshuan,
  matchHaidilaoyue,
  matchTiandipao,
  matchJiachepao,
  matchMensha,
  matchShuangchecuo,
  matchErguipaimen,
  matchSelfBlocked
];

/**
 * 识别杀法
 *
 * @param {Position} pos 已经走完最后一步的局面
 * @param {number} atkSide 胜方（正在将军的一方）
 * @returns {?{key:string, name:string, why:string}} 认不出时返回 null
 */
function classifyMate(pos, atkSide) {
  if (!pos || !pos.board) return null;
  var defSide = 1 - atkSide;
  var kingIdx = pos.kingPos[defSide];
  if (kingIdx < 0) return null;

  var ctx = {
    pos: pos,
    board: pos.board,
    atkSide: atkSide,
    defSide: defSide,
    kingIdx: kingIdx,
    checkers: findCheckers(pos, atkSide)
  };

  // 没有任何子力将军时，唯一可能是「将帅照面」——也由匹配器链统一处理
  for (var i = 0; i < MATCHERS.length; i++) {
    var hit = MATCHERS[i](ctx);
    if (hit) return hit;
  }
  return null;
}

module.exports = classifyMate;
module.exports.classifyMate = classifyMate;
module.exports.MATE_PATTERNS = MATE_PATTERNS;
module.exports.MATCHERS = MATCHERS;
module.exports.between = between;
module.exports.horseTerm = horseTerm;
module.exports.cannonScreen = cannonScreen;
