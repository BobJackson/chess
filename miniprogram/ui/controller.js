/**
 * 触摸交互控制器
 *
 * 把 Canvas 的触摸事件翻译为「选中 / 落点提示 / 走子请求」，
 * 同时维护渲染所需的视图状态，供 renderer.draw 直接使用。
 *
 * 支持两种操作方式并存：
 *   点击式 —— 先点起点选中，再点落点走子
 *   拖拽式 —— 按住棋子拖到落点松手
 *
 * 走子成功后播放「走子动画」：把刚走的那枚棋子从起点滑到终点，
 * 而不是让它在终点凭空出现。动画期间暂停收输入，播完通过 onAnimEnd 通知外部。
 *
 * 是否允许操作由外部注入的 canMove 决定（人机模式下 AI 思考时禁止、
 * 联机模式下只有轮到自己才允许）。
 *
 * 纯 JavaScript，无 wx 依赖。
 */

var C = require('../core/constants.js');

/** 拖动超过该比例格距才算拖拽，否则视为点击 */
var DRAG_RATIO = 0.35;

/** 走子动画时长（毫秒） */
var MOVE_DURATION = 200;

/**
 * @constructor
 * @param {Layout} layout
 * @param {Game} game
 * @param {object} [options] {
 *   canMove: function():boolean,   当前是否允许本地操作
 *   onMoved: function(result),     走子成功后回调
 *   onIllegal: function(message),  走子被拒后回调
 *   onSelect: function(idx,targets), 选中棋子后回调
 *   onCapture: function(entry),    吃子后回调（用于音效/振动）
 *   onAnimEnd: function(anim),     走子动画播完回调（用于 AI 回手/终局弹窗）
 * }
 */
function Controller(layout, game, options) {
  this.layout = layout;
  this.game = game;
  this.options = options || {};

  /** 当前选中的棋子索引，-1 表示未选中 */
  this.selected = -1;
  /** 选中棋子的全部合法落点 */
  this.targets = [];
  /** 拖拽状态 */
  this.drag = null;
  /** AI 提示着法 */
  this.hint = null;
  /** 将军脉冲相位 0~1 */
  this.pulse = 0;
  /** 走子动画 {from,to,piece,captured,t,dur}，null 表示无动画 */
  this.anim = null;
}

/** 是否允许本地操作（对局未结束、动画已落定且外部许可） */
Controller.prototype.canOperate = function () {
  if (!this.game || this.game.result) return false;
  if (this.anim) return false;   // 棋子还在飞，等落定再收输入
  var fn = this.options.canMove;
  return typeof fn === 'function' ? !!fn() : true;
};

/** 换用另一局（重新开始、联机重连后重建局面） */
Controller.prototype.setGame = function (game) {
  this.game = game;
  this.reset();
  return this;
};

/** 清空视图状态（不影响对局本身） */
Controller.prototype.reset = function () {
  this.selected = -1;
  this.targets = [];
  this.drag = null;
  this.hint = null;
  this.pulse = 0;
  this.anim = null;
  return this;
};

Controller.prototype.clearSelection = function () {
  this.selected = -1;
  this.targets = [];
};

/** 选中一枚棋子并计算其落点 */
Controller.prototype.select = function (idx) {
  this.selected = idx;
  this.targets = this.game.legalTargets(idx);
  if (this.options.onSelect) this.options.onSelect(idx, this.targets);
  return this.targets;
};

/**
 * 请求走子。成功后清空选中与提示、播放走子动画，并触发回调。
 * @returns {object} Game.move 的结果
 */
Controller.prototype.requestMove = function (from, to) {
  var res = this.game.move(from, to);
  if (!res.ok) {
    if (this.options.onIllegal) this.options.onIllegal(res.error);
    return res;
  }
  this.clearSelection();
  this.hint = null;
  this.drag = null;
  // 先起动画再回调：回调里可能要判断「动画是否在播」来决定后续流程
  this.playMoveAnim(res.entry);
  if (res.entry.captured !== C.EMPTY && this.options.onCapture) {
    this.options.onCapture(res.entry);
  }
  if (this.options.onMoved) this.options.onMoved(res);
  return res;
};

// ---------------------------------------------------------------------------
// 走子动画
// ---------------------------------------------------------------------------

/**
 * 播放走子动画：把刚走的那枚棋子从起点滑到终点
 *
 * 对局状态在 Game.move 时已即时更新（终点格上已有棋子），所以动画期间由
 * 渲染层「跳过终点格 + 在途绘制飞行棋子」来表现移动过程，逻辑层无需回滚。
 *
 * @param {object} entry Game.move 返回的着法记录 {from,to,piece,captured}
 * @param {object} [opts] { instant: true } 直接落定、不播动画（重连/重放用）
 * @returns {?object} 动画状态；未播放时返回 null
 */
Controller.prototype.playMoveAnim = function (entry, opts) {
  if (opts && opts.instant) { this.anim = null; return null; }
  if (!entry || typeof entry.from !== 'number' || typeof entry.to !== 'number') return null;
  if (entry.from === entry.to) return null;

  var piece = typeof entry.piece === 'number' && entry.piece !== C.EMPTY
    ? entry.piece
    : (this.game ? this.game.pos.board[entry.to] : C.EMPTY);

  this.anim = {
    from: entry.from,
    to: entry.to,
    piece: piece,
    captured: typeof entry.captured === 'number' ? entry.captured : C.EMPTY,
    t: 0,
    dur: MOVE_DURATION
  };
  return this.anim;
};

/** 是否正在播放走子动画（用于跳过输入、驱动重绘） */
Controller.prototype.isAnimating = function () {
  return !!this.anim;
};

/** 立即结束走子动画（直接落定，不触发 onAnimEnd） */
Controller.prototype.finishAnim = function () {
  var anim = this.anim;
  this.anim = null;
  return anim;
};

/** 指定一枚己方棋子由代码选中（提示、AI 演示等场景） */
Controller.prototype.focusIdx = function (idx) {
  if (idx < 0 || idx >= C.BOARD_SIZE) { this.clearSelection(); return []; }
  return this.select(idx);
};

/** 设置 AI 提示着法 */
Controller.prototype.setHint = function (hint) {
  this.hint = hint && typeof hint.from === 'number' ? hint : null;
  return this.hint;
};

/** 推进将军脉冲与走子动画（由页面按帧驱动） */
Controller.prototype.tick = function (dt) {
  var ms = dt || 16;

  var step = ms / 900;
  this.pulse += step;
  if (this.pulse > 1) this.pulse -= Math.floor(this.pulse);

  var anim = this.anim;
  if (anim) {
    anim.t += ms / anim.dur;
    if (anim.t >= 1) {
      anim.t = 1;
      this.anim = null;
      // 动画播完才通知外部（AI 回手、终局弹窗都等棋子落定）
      if (this.options.onAnimEnd) this.options.onAnimEnd(anim);
    }
  }
  return this.pulse;
};

// ---------------------------------------------------------------------------
// 触摸事件
// ---------------------------------------------------------------------------

/**
 * 触摸开始
 * @returns {boolean} 是否产生了需要重绘的状态变化
 */
Controller.prototype.touchStart = function (x, y) {
  if (!this.canOperate()) return false;

  // 单手势模型：一次触摸序列（按下到抬起/取消）内只认第一根手指。
  // 忽略多指误触，避免拖拽途中被第二根手指改写起点或选中。
  if (this.drag) return false;

  var idx = this.layout.hitTest(x, y);
  if (idx < 0) {
    var had = this.selected >= 0;
    this.clearSelection();
    return had;
  }

  // 1) 点选模式的第二步：落在已选棋子的合法落点上
  if (this.selected >= 0 && this.targets.indexOf(idx) >= 0) {
    this.requestMove(this.selected, idx);
    return true;
  }

  // 2) 点在己方棋子上：选中并进入拖拽预备
  var piece = this.game.pos.board[idx];
  var isMine = piece !== C.EMPTY && C.sideOf(piece) === this.game.pos.side;
  if (isMine) {
    var changed = this.selected !== idx || this.drag !== null;
    this.select(idx);
    this.drag = {
      from: idx, piece: piece,
      startX: x, startY: y, x: x, y: y,
      moved: false, hover: -1
    };
    return changed || this.targets.length > 0;
  }

  // 3) 点在空位或敌子上：取消选中
  var hadSelection = this.selected >= 0;
  this.clearSelection();
  return hadSelection;
};

/** 触摸移动 */
Controller.prototype.touchMove = function (x, y) {
  if (!this.drag) return false;

  var threshold = this.layout.cell * DRAG_RATIO;
  var dx = x - this.drag.startX;
  var dy = y - this.drag.startY;
  if (!this.drag.moved && dx * dx + dy * dy > threshold * threshold) {
    this.drag.moved = true;
  }
  this.drag.x = x;
  this.drag.y = y;

  var idx = this.layout.hitTest(x, y);
  this.drag.hover = (idx >= 0 && this.targets.indexOf(idx) >= 0) ? idx : -1;
  return this.drag.moved;
};

/**
 * 触摸结束
 * 拖动过则按落点判定走子；仅点击则保留选中，等待下一次点击
 */
Controller.prototype.touchEnd = function (x, y) {
  var drag = this.drag;
  this.drag = null;
  if (!drag || !drag.moved) return false;

  var idx = this.layout.hitTest(x, y);
  if (idx >= 0 && this.targets.indexOf(idx) >= 0) {
    this.requestMove(drag.from, idx);
    return true;
  }
  // 拖到非法位置：棋子回位但保持选中，方便改点
  return true;
};

/** 触摸取消（来电、切后台等） */
Controller.prototype.touchCancel = function () {
  this.drag = null;
  return true;
};

// ---------------------------------------------------------------------------
// 渲染状态
// ---------------------------------------------------------------------------

/**
 * 生成 renderer.draw 所需的状态对象
 * @returns {object}
 */
Controller.prototype.renderState = function () {
  var game = this.game;
  var board = game ? game.pos.board : null;
  var anim = this.anim;

  // 动画期间不画「上一步」四角标记：终点格还没被走到，标记会提前剧透落点
  var lastMove = null;
  if (game && !anim) {
    var last = game.lastEntry();
    if (last) lastMove = { from: last.from, to: last.to };
  }

  var checkIdx = -1;
  if (game && !game.result && game.isChecked()) {
    checkIdx = game.pos.kingPos[game.pos.side];
  }

  var dragging = this.drag && this.drag.moved ? this.drag : null;

  return {
    board: board,
    // 拖拽中棋子已离开原位，不再画选中环
    selected: dragging ? -1 : this.selected,
    targets: this.targets,
    lastMove: lastMove,
    checkIdx: checkIdx,
    pulse: this.pulse,
    hint: this.hint,
    moving: dragging ? {
      from: dragging.from, x: dragging.x, y: dragging.y, piece: dragging.piece,
      // 手指正悬停的合法落点，供渲染层画「松手落点」高亮
      hover: dragging.hover
    } : null,
    // 正在移动的那枚棋子：渲染层据此跳过终点格并绘制在途棋子
    anim: anim ? {
      from: anim.from, to: anim.to, piece: anim.piece,
      captured: anim.captured, t: anim.t
    } : null
  };
};

/** 渲染后驱动一次绘制（页面把 ctx 传进来） */
Controller.prototype.render = function (ctx, renderer) {
  renderer.draw(ctx, this.layout, this.renderState());
};

module.exports = Controller;
module.exports.DRAG_RATIO = DRAG_RATIO;
module.exports.MOVE_DURATION = MOVE_DURATION;
