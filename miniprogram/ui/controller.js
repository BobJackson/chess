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
 * 是否允许操作由外部注入的 canMove 决定（人机模式下 AI 思考时禁止、
 * 联机模式下只有轮到自己才允许）。
 *
 * 纯 JavaScript，无 wx 依赖。
 */

var C = require('../core/constants.js');

/** 拖动超过该比例格距才算拖拽，否则视为点击 */
var DRAG_RATIO = 0.35;

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
}

/** 是否允许本地操作（对局未结束且外部许可） */
Controller.prototype.canOperate = function () {
  if (!this.game || this.game.result) return false;
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
 * 请求走子。成功后清空选中与提示，并触发回调。
 * @returns {object} Game.move 的结果
 */
Controller.prototype.requestMove = function (from, to) {
  var entry = this.game.history.length ? this.game.history[this.game.history.length - 1] : null;
  var res = this.game.move(from, to);
  if (!res.ok) {
    if (this.options.onIllegal) this.options.onIllegal(res.error);
    return res;
  }
  this.clearSelection();
  this.hint = null;
  this.drag = null;
  if (res.entry.captured !== C.EMPTY && this.options.onCapture) {
    this.options.onCapture(res.entry);
  }
  if (this.options.onMoved) this.options.onMoved(res);
  return res;
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

/** 推进将军脉冲动画相位 */
Controller.prototype.tick = function (dt) {
  var step = (dt || 16) / 900;
  this.pulse += step;
  if (this.pulse > 1) this.pulse -= Math.floor(this.pulse);
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

  var lastMove = null;
  if (game) {
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
    } : null
  };
};

/** 渲染后驱动一次绘制（页面把 ctx 传进来） */
Controller.prototype.render = function (ctx, renderer) {
  renderer.draw(ctx, this.layout, this.renderState());
};

module.exports = Controller;
module.exports.DRAG_RATIO = DRAG_RATIO;
