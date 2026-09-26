/**
 * 主题色板：松桂（默认，米白暖木）与紫金夜（深空紫金）
 *
 * 切换机制：模块加载时先给三块现有色板（renderer.THEME / widgets.THEME /
 * chrome.PALETTE）拍一张「出厂快照」当松桂基线；setTheme 先把快照就地
 * 还原，再叠加目标主题的差量——所有绘制调用点持有原对象引用，零改动生效。
 *
 * 绝杀演出（endgame.js）的琥珀-深色配色两套主题下都成立，不参与切换；
 * 粒子木屑/桂花是内容色而非 UI 色，同样不随主题变。
 *
 * 持久化：chess_theme（wx.setStorageSync，无 wx 环境静默跳过，测试友好）。
 * 纯 JavaScript，无 wx 依赖（wx 调用全部有守卫）。
 */

var Renderer = require('./renderer.js');
var W = require('./widgets.js');
var Chrome = require('./chrome.js');

var STORAGE_KEY = 'chess_theme';

function snapshot(obj) {
  var out = {};
  for (var k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    var v = obj[k];
    out[k] = (v && v.slice) ? v.slice(0) : v; // 数组（bgStops）拷一份
  }
  return out;
}

/** 出厂基线 = 松桂主题（各模块的原装色值） */
var BASE = {
  renderer: snapshot(Renderer.THEME),
  widgets: snapshot(W.THEME),
  chrome: snapshot(Chrome.PALETTE)
};

// ---------------------------------------------------------------------------
// 主题差量：只写与松桂不同的键
// ---------------------------------------------------------------------------

/** 紫金夜：深空底 + 紫微盘 + 金线 + 米白子 + 紫高光 */
var NEBULA = {
  renderer: {
    bgTop: '#3a2563',
    bgBottom: '#291a49',
    boardEdge: '#c9a86a',
    line: '#d9b878',
    riverText: 'rgba(217,184,120,0.45)',
    pieceFaceTop: '#fffaf0',
    pieceFaceMid: '#fdf3d8',
    pieceFaceBottom: '#e8dcc0',
    pieceEdge: '#8a6db8',
    pieceShadow: 'rgba(8,4,20,0.55)',
    redText: '#e04a3a',
    blackText: '#2a1f45',
    selected: '#9b7bff',
    target: 'rgba(126,200,150,0.90)',
    capture: 'rgba(224,74,58,0.92)',
    lastMove: 'rgba(233,168,52,0.95)',
    check: 'rgba(224,74,58,0.95)',
    hint: 'rgba(155,123,255,0.92)',
    threat: 'rgba(224,74,58,0.95)'
  },
  widgets: {
    bg: '#1a1230',
    panel: '#2a1b47',
    primary: '#5b3a96',
    primaryText: '#f2dcae',
    primaryDown: '#452a78',
    ghostBorder: '#b98f52',
    ghostText: '#e6c98a',
    ghostDown: 'rgba(217,184,120,0.14)',
    title: '#f2dcae',
    subtitle: '#a98fc9',
    body: '#e6d9f5',
    segBg: '#2a1b47',
    segOn: '#5b3a96',
    segText: '#c9b1e6',
    segOnText: '#f2dcae',
    danger: '#e04a3a',
    accentSong: '#e6c98a',
    accentGui: '#e04a3a',
    accentDraw: '#a98fc9',
    divider: 'rgba(217,184,120,0.18)',
    inputFill: '#2a1b47',
    inputEdge: '#b98f52',
    inputHint: '#a98fc9'
  },
  chrome: {
    bgStops: ['#1e1436', '#181029', '#110b20'],
    panelFill: '#2a1b47',
    panelShadow: 'rgba(0,0,0,0.45)',
    panelStroke: 'rgba(217,184,120,0.45)',
    ornament: 'rgba(217,184,120,0.35)',
    watermark: '#d9b878'
  }
};

/** 主题清单：key 用于存储与寻址，name 用于设置页分段标签 */
var THEMES = [
  { key: 'pine', name: '松桂', diff: null },
  { key: 'nebula', name: '紫金夜', diff: NEBULA }
];

var current = 'pine';

function find(key) {
  for (var i = 0; i < THEMES.length; i++) {
    if (THEMES[i].key === key) return THEMES[i];
  }
  return null;
}

function assignInto(target, values) {
  for (var k in values) {
    if (!Object.prototype.hasOwnProperty.call(values, k)) continue;
    var v = values[k];
    target[k] = (v && v.slice) ? v.slice(0) : v;
  }
}

/** 应用主题（不持久化；未知 key 静默忽略并返回 false） */
function apply(key) {
  var theme = find(key);
  if (!theme) return false;
  // 先还原出厂基线，再叠加差量——松桂的 diff 为空，即纯还原
  assignInto(Renderer.THEME, BASE.renderer);
  assignInto(W.THEME, BASE.widgets);
  assignInto(Chrome.PALETTE, BASE.chrome);
  if (theme.diff) {
    assignInto(Renderer.THEME, theme.diff.renderer);
    assignInto(W.THEME, theme.diff.widgets);
    assignInto(Chrome.PALETTE, theme.diff.chrome);
  }
  current = key;
  return true;
}

/** 切换主题并持久化 */
function setTheme(key) {
  if (!apply(key)) return false;
  if (typeof wx !== 'undefined' && wx.setStorageSync) {
    try { wx.setStorageSync(STORAGE_KEY, key); } catch (e) {}
  }
  return true;
}

/** 启动时调用：读出持久化的主题并应用（无记录则保持松桂） */
function init() {
  if (typeof wx !== 'undefined' && wx.getStorageSync) {
    var saved = null;
    try { saved = wx.getStorageSync(STORAGE_KEY) || null; } catch (e) {}
    if (saved && find(saved)) apply(saved);
  }
  return current;
}

module.exports = {
  THEMES: THEMES,
  key: function () { return current; },
  nameOf: function (key) { var t = find(key); return t ? t.name : ''; },
  indexOf: function (key) {
    for (var i = 0; i < THEMES.length; i++) if (THEMES[i].key === key) return i;
    return 0;
  },
  apply: apply,
  setTheme: setTheme,
  init: init
};
