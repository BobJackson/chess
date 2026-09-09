/**
 * 棋盘几何布局
 *
 * 中国象棋棋盘为 9 条纵线 × 10 条横线，棋子落在交叉点上。
 * 本模块负责「棋盘索引 ↔ 画布像素」的双向换算，并支持翻转视角
 * （联机时自己执黑则把黑方放到屏幕下方）。
 *
 * 所有尺寸均为逻辑像素（CSS px），由页面按屏幕宽度创建。
 * 纯 JavaScript，无 wx 依赖，可在 node 下测试。
 */

var C = require('../core/constants.js');

/** 棋盘四周留白相对格距的比例 */
var PADDING_RATIO = 0.62;

/** 触摸命中半径相对格距的比例（略大于半格，边缘更好点中） */
var HIT_RATIO = 0.55;

/** 棋子半径相对格距的比例 */
var PIECE_RATIO = 0.44;

/**
 * @constructor
 * @param {number} width 画布逻辑宽度
 * @param {boolean} [flipped] true 表示黑方视角（黑方在屏幕下方）
 */
function Layout(width, flipped) {
  this.flipped = !!flipped;
  this.width = 0;
  this.height = 0;
  this.padding = 0;
  this.cell = 0;
  this.pieceRadius = 0;
  this.hitRadius = 0;
  this.resize(width);
}

/**
 * 按给定宽度重算全部尺寸
 * @param {number} width
 */
Layout.prototype.resize = function (width) {
  var w = Math.max(1, width);
  // 宽度 = 8 个格距 + 两侧留白
  this.width = w;
  this.cell = w / (C.FILES - 1 + PADDING_RATIO * 2);
  this.padding = this.cell * PADDING_RATIO;
  this.height = this.cell * (C.RANKS - 1) + this.padding * 2;
  this.pieceRadius = this.cell * PIECE_RATIO;
  this.hitRadius = this.cell * HIT_RATIO;
  return this;
};

/** 切换视角（联机换边、本地双人轮换） */
Layout.prototype.setFlipped = function (flipped) {
  this.flipped = !!flipped;
  return this;
};

/** 索引 -> 屏幕横坐标 */
Layout.prototype.xOf = function (idx) {
  var file = C.fileOf(idx);
  if (this.flipped) file = C.FILES - 1 - file;
  return this.padding + file * this.cell;
};

/** 索引 -> 屏幕纵坐标 */
Layout.prototype.yOf = function (idx) {
  var rank = C.rankOf(idx);
  if (this.flipped) rank = C.RANKS - 1 - rank;
  return this.padding + rank * this.cell;
};

/** 索引 -> 屏幕坐标点 */
Layout.prototype.pointOf = function (idx) {
  return { x: this.xOf(idx), y: this.yOf(idx) };
};

/**
 * 触摸坐标 -> 棋盘索引
 * @returns {number} 命中的交叉点索引，超出棋盘或偏离过远返回 -1
 */
Layout.prototype.hitTest = function (x, y) {
  if (typeof x !== 'number' || typeof y !== 'number') return -1;
  if (!isFinite(x) || !isFinite(y)) return -1;

  var file = Math.round((x - this.padding) / this.cell);
  var rank = Math.round((y - this.padding) / this.cell);
  if (this.flipped) {
    file = C.FILES - 1 - file;
    rank = C.RANKS - 1 - rank;
  }
  if (file < 0 || file >= C.FILES || rank < 0 || rank >= C.RANKS) return -1;

  var idx = C.idxOf(file, rank);
  var dx = x - this.xOf(idx);
  var dy = y - this.yOf(idx);
  if (dx * dx + dy * dy > this.hitRadius * this.hitRadius) return -1;
  return idx;
};

/**
 * 某个交叉点的包围盒（用于绘制高亮块）
 * @param {number} idx
 * @param {number} [size] 边长，缺省为一个格距
 */
Layout.prototype.rectOf = function (idx, size) {
  var s = size || this.cell;
  return {
    x: this.xOf(idx) - s / 2,
    y: this.yOf(idx) - s / 2,
    w: s,
    h: s
  };
};

/** 画布尺寸（供页面设置 canvas.width / style.height） */
Layout.prototype.size = function () {
  return { width: this.width, height: this.height };
};

/**
 * 屏幕坐标是否在棋盘范围内（含留白）
 */
Layout.prototype.contains = function (x, y) {
  return x >= 0 && x <= this.width && y >= 0 && y <= this.height;
};

module.exports = Layout;
module.exports.PADDING_RATIO = PADDING_RATIO;
module.exports.HIT_RATIO = HIT_RATIO;
module.exports.PIECE_RATIO = PIECE_RATIO;
