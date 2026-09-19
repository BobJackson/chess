/**
 * 对局控制器（Game）
 *
 * 在 Position 之上封装完整对局流程：走子校验、着法记录、悔棋、终局判定，
 * 以及供联机同步使用的「起始 FEN + 着法序列」序列化格式。
 *
 * 终局判定覆盖：
 *  - 将死 / 困毙（中国象棋两者均判负）
 *  - 三次重复局面，并进一步区分「长将判负」与「不变作和」
 *  - 自然限着（连续若干手无吃子判和）
 *
 * 纯 JavaScript，无 wx 依赖，人机与联机共用同一套逻辑。
 */

var C = require('./constants.js');
var MG = require('./movegen.js');
var Position = require('./position.js');
var NT = require('./notation.js');
var Mate = require('./mate.js');

/** 和棋（result.winner 取值） */
var DRAW = -1;

/** 自然限着：连续 120 手（60 回合）无吃子判和 */
var NO_CAPTURE_LIMIT = 120;

/** 同一局面出现该次数即触发重复判定 */
var REPETITION_LIMIT = 3;

/**
 * @constructor
 * @param {string} [fen] 起始局面，省略则用标准开局
 */
function Game(fen) {
  this.startFen = fen || C.START_FEN;
  this.pos = new Position(this.startFen);
  /** @type {Array<{from:number,to:number,piece:number,captured:number,side:number,
   *               text:string,check:boolean,sig:string,undo:object,
   *               noCaptureBefore:number}>} */
  this.history = [];
  /** 局面指纹 -> 出现次数（含起始局面） */
  this.repetition = {};
  /** @type {?{winner:number, reason:string, text:string}} */
  this.result = null;
  this.noCapturePlies = 0;
  /** 自然限着阈值（手），可在实例上调整以适配不同规则或测试 */
  this.noCaptureLimit = NO_CAPTURE_LIMIT;

  /** 起始局面指纹：重复循环可能把开局局面包含在内 */
  this.startSig = this.pos.signature();
  this.repetition[this.startSig] = 1;
  this._undo = { from: 0, to: 0, piece: 0, captured: 0, side: 0 };
}

/**
 * 撤销一步（内部使用，不做终局重算以外的业务判断）
 */
Game.prototype._undoOne = function () {
  var entry = this.history.pop();
  if (!entry) return null;

  this.pos.unmakeMove(entry.undo);
  // 吃子会把计数清零，故按步保存走子前的值以便精确还原
  this.noCapturePlies = entry.noCaptureBefore;

  var count = this.repetition[entry.sig];
  if (count !== undefined) {
    if (count <= 1) delete this.repetition[entry.sig];
    else this.repetition[entry.sig] = count - 1;
  }
  return entry;
};

/**
 * 走一步棋
 *
 * @param {number} from 起点索引
 * @param {number} to 终点索引
 * @returns {{ok:boolean, error?:string, text?:string,
 *            entry?:object, result?:?object}}
 */
Game.prototype.move = function (from, to) {
  if (this.result) {
    return { ok: false, error: '对局已结束' };
  }
  if (!MG.isMoveLegal(this.pos, this.pos.side, from, to)) {
    return { ok: false, error: '不符合走法' };
  }

  var side = this.pos.side;
  var piece = this.pos.board[from];
  var captured = this.pos.board[to];
  var text = NT.moveText(this.pos, from, to);

  // undo 记录需按步保存，不能复用同一个对象
  var undo = { from: 0, to: 0, piece: 0, captured: 0, side: 0 };
  this.pos.makeMove(from, to, undo);

  var sig = this.pos.signature();
  var check = MG.isChecked(this.pos, this.pos.side);

  var entry = {
    from: from, to: to, piece: piece, captured: captured,
    side: side, text: text, check: check, sig: sig, undo: undo,
    noCaptureBefore: this.noCapturePlies
  };
  this.history.push(entry);

  if (captured === C.EMPTY) this.noCapturePlies++;
  else this.noCapturePlies = 0;
  this.repetition[sig] = (this.repetition[sig] || 0) + 1;

  this.result = this._detectResult(entry);

  // 记谱后缀：将死记「绝杀」，普通将军记「将」
  if (this.result && this.result.winner !== DRAW) entry.text += '绝杀';
  else if (check) entry.text += '将';

  return { ok: true, text: entry.text, entry: entry, result: this.result };
};

/**
 * 悔棋
 * @param {number} [plies=1] 回退的手数
 * @returns {number} 实际回退的手数
 */
Game.prototype.undo = function (plies) {
  var n = Math.max(1, plies || 1);
  var done = 0;
  while (done < n && this.history.length > 0) {
    this._undoOne();
    done++;
  }
  // 回退后对局重新开放（认输等人为终局也随之取消）
  this.result = null;
  return done;
};

/**
 * 选中某枚己方棋子后，返回其全部合法落点
 * @param {number} from 起点索引
 * @returns {number[]} 终点索引数组
 */
Game.prototype.legalTargets = function (from) {
  if (this.result) return [];
  var piece = this.pos.board[from];
  if (piece === C.EMPTY || C.sideOf(piece) !== this.pos.side) return [];

  var all = MG.genLegalMoves(this.pos, this.pos.side);
  var targets = [];
  for (var i = 0; i < all.length; i++) {
    if (MG.moveFrom(all[i]) === from) targets.push(MG.moveTo(all[i]));
  }
  return targets;
};

/** 当前走子方是否被将军 */
Game.prototype.isChecked = function () {
  return MG.isChecked(this.pos, this.pos.side);
};

/** 当前走子方是否还有合法走法 */
Game.prototype.hasMove = function () {
  return !this.result && MG.hasLegalMove(this.pos, this.pos.side);
};

/** 已走手数 */
Game.prototype.plyCount = function () {
  return this.history.length;
};

/** 最后一手（无则 null） */
Game.prototype.lastEntry = function () {
  return this.history.length ? this.history[this.history.length - 1] : null;
};

/** 全部中文着法 */
Game.prototype.moveTexts = function () {
  var out = [];
  for (var i = 0; i < this.history.length; i++) out.push(this.history[i].text);
  return out;
};

/** 按回合排版的着法文本 */
Game.prototype.moveList = function () {
  return NT.formatMoveList(this.moveTexts());
};

/**
 * 局面摘要，供 UI 与联机同步使用
 */
Game.prototype.status = function () {
  var last = this.lastEntry();
  return {
    side: this.pos.side,
    checked: this.isChecked(),
    finished: !!this.result,
    result: this.result,
    ply: this.history.length,
    round: Math.floor(this.history.length / 2) + 1,
    lastMove: last ? { from: last.from, to: last.to, text: last.text } : null,
    fen: this.pos.toFen(),
    noCapturePlies: this.noCapturePlies
  };
};

/**
 * 主动结束对局（认输 / 超时 / 对手退出）
 * @param {number} winner 胜方阵营
 * @param {string} reason 原因文本
 */
Game.prototype.finish = function (winner, reason) {
  if (this.result) return this.result;

  // 联机时终局是对方广播过来的，reason 为「将死」时本地局面已经同步到终局，
  // 所以能就地重算杀法名，保证双方弹窗与语音一致
  var mate = ((winner === C.RED || winner === C.BLACK) && reason === '将死')
    ? Mate.classifyMate(this.pos, winner)
    : null;

  this.result = {
    winner: winner,
    reason: reason,
    mate: mate ? mate.name : null,
    mateKey: mate ? mate.key : null,
    text: (mate ? mate.name + '，' : '') + reason +
      (winner === DRAW ? '，和棋' : '，' + sideName(winner) + '胜')
  };
  return this.result;
};

// ---------------------------------------------------------------------------
// 终局判定
// ---------------------------------------------------------------------------

/**
 * 走完 entry 之后判断对局是否结束
 * @returns {?object} result
 */
Game.prototype._detectResult = function (entry) {
  var mover = entry.side;
  var opponent = this.pos.side; // makeMove 之后 pos.side 已是对方

  // 1) 无子可动：将死或困毙，均判走子方胜
  if (!MG.hasLegalMove(this.pos, opponent)) {
    var mated = MG.isChecked(this.pos, opponent);
    // 只有将死才谈得上杀法；困毙是「无子可动」，不是杀
    var mate = mated ? Mate.classifyMate(this.pos, mover) : null;
    return {
      winner: mover,
      reason: mated ? '将死' : '困毙',
      // 杀法名与稳定的 ASCII key（供语音等外部资源引用），认不出时均为 null
      mate: mate ? mate.name : null,
      mateKey: mate ? mate.key : null,
      text: (mate ? mate.name + '，' : '') +
        (mated ? '绝杀无解' : '无子可动') + '，' + sideName(mover) + '胜'
    };
  }

  // 2) 三次重复局面：区分长将与不变作和
  if ((this.repetition[entry.sig] || 0) >= REPETITION_LIMIT) {
    var perpetual = this._perpetualCheckSide(entry.sig);
    if (perpetual !== null) {
      var winnerOfPerpetual = perpetual === C.RED ? C.BLACK : C.RED;
      return {
        winner: winnerOfPerpetual,
        reason: '长将判负',
        text: sideName(perpetual) + '长将不变，判负，' + sideName(winnerOfPerpetual) + '胜'
      };
    }
    return { winner: DRAW, reason: '三次重复局面', text: '双方不变作和' };
  }

  // 3) 自然限着
  if (this.noCapturePlies >= this.noCaptureLimit) {
    return {
      winner: DRAW,
      reason: '自然限着',
      text: '连续 ' + (this.noCaptureLimit / 2) + ' 回合无吃子，判和'
    };
  }

  return null;
};

/**
 * 在重复循环段中查找「单方连续将军」
 *
 * 循环段取该局面第一次出现之后、到最后一次出现之间的全部着法，
 * 段位内某方每一手都在将军而对方不是，则该方长将。
 *
 * @param {string} sig 重复出现的局面指纹
 * @returns {?number} 长将方；双方都长将或都不长将时返回 null
 */
Game.prototype._perpetualCheckSide = function (sig) {
  var indices = [];
  for (var i = 0; i < this.history.length; i++) {
    if (this.history[i].sig === sig) indices.push(i);
  }
  if (indices.length < REPETITION_LIMIT && sig !== this.startSig) return null;

  // 起始局面不在 history 中；若它也参与了重复，循环段就从第一手算起
  var begin = indices.length >= REPETITION_LIMIT ? indices[0] : -1;
  var end = indices[indices.length - 1];

  var redTotal = 0;
  var redCheck = 0;
  var blackTotal = 0;
  var blackCheck = 0;

  for (var j = begin + 1; j <= end; j++) {
    var h = this.history[j];
    if (h.side === C.RED) {
      redTotal++;
      if (h.check) redCheck++;
    } else {
      blackTotal++;
      if (h.check) blackCheck++;
    }
  }

  var redPerpetual = redTotal > 0 && redCheck === redTotal;
  var blackPerpetual = blackTotal > 0 && blackCheck === blackTotal;

  if (redPerpetual && !blackPerpetual) return C.RED;
  if (blackPerpetual && !redPerpetual) return C.BLACK;
  return null;
};

// ---------------------------------------------------------------------------
// 序列化：起始 FEN + 着法序列，用于联机同步与本地存档
// ---------------------------------------------------------------------------

/** 导出为可 JSON 化的最小对象 */
Game.prototype.toJSON = function () {
  var moves = [];
  for (var i = 0; i < this.history.length; i++) {
    moves.push([this.history[i].from, this.history[i].to]);
  }
  var data = { fen: this.startFen, moves: moves };
  if (this.result) {
    data.result = { winner: this.result.winner, reason: this.result.reason };
  }
  return data;
};

/** 由导出对象重建对局 */
Game.fromJSON = function (data) {
  var game = new Game(data && data.fen ? data.fen : C.START_FEN);
  if (data && data.moves && data.moves.length) {
    game.applyMoves(data.moves);
  }
  if (data && data.result && !game.result) {
    game.finish(data.result.winner, data.result.reason || '对局结束');
  }
  return game;
};

/**
 * 依序重放着法（联机收到对手状态时使用）
 * 非法着法将被忽略并返回已重放的手数，避免脏数据导致崩溃。
 *
 * @param {Array<number[]|number>} moves 着法序列，元素为 [from, to] 或打包整数
 * @returns {number} 成功重放的手数
 */
Game.prototype.applyMoves = function (moves) {
  var applied = 0;
  for (var i = 0; i < moves.length; i++) {
    var item = moves[i];
    var from;
    var to;
    if (typeof item === 'number') {
      from = MG.moveFrom(item);
      to = MG.moveTo(item);
    } else if (item && item.length >= 2) {
      from = item[0];
      to = item[1];
    } else {
      break;
    }
    var res = this.move(from, to);
    if (!res.ok) break;
    applied++;
  }
  return applied;
};

/**
 * 从一组着法重建对局（工具方法）
 * @param {string} fen
 * @param {Array} moves
 */
Game.replay = function (fen, moves) {
  var game = new Game(fen);
  game.applyMoves(moves || []);
  return game;
};

function sideName(side) {
  if (side === C.RED) return '红方';
  if (side === C.BLACK) return '黑方';
  return '双方';
}

module.exports = Game;
module.exports.DRAW = DRAW;
module.exports.NO_CAPTURE_LIMIT = NO_CAPTURE_LIMIT;
module.exports.REPETITION_LIMIT = REPETITION_LIMIT;
module.exports.sideName = sideName;
