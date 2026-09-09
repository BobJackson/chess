/**
 * 规则场景：可滚动的纯文本说明 + 返回按钮
 */
var W = require('../ui/widgets.js');

var SECTIONS = [
  ['棋盘与目标', [
    '棋盘为 9 条纵线 × 10 条横线，棋子走在交叉点上，双方各 16 枚。中间为楚河汉界，两侧各有九宫。',
    '红方先行，双方轮流走子。把对方的将（帅）将死，或使对方无子可动，即获胜。'
  ]],
  ['棋子走法', [
    '帥（將）：只在九宫内每次走一步直线。',
    '仕（士）：只在九宫内每次走一步斜线。',
    '相（象）：走田字，不能过河，田心被堵则不能走。',
    '傌：走日字，蹩腿时不能走。',
    '俥（車）：直线任意格数，不能越子。',
    '炮（砲）：直线移动不吃子时可越子；吃子时必须隔恰好一枚棋子（炮架）。',
    '兵（卒）：过河前只能向前一步；过河后可向前或横走一步，永远不能后退。'
  ]],
  ['将军与胜负', [
    '走子后威胁对方將（帥）称为将军，被將方必须立即应将。',
    '將死（无法应将）或困毙（无子可动）均判负。',
    '双方將（帥）不能在同一条纵线上直接照面。',
    '长將判负；三次重复局面判和；连续 60 回合无吃子判和。'
  ]],
  ['操作说明', [
    '点选：先点己方棋子，再点绿色落点走子。',
    '拖拽：按住棋子拖到落点松手，拖拽中高亮松手落点。',
    '工具栏：悔棋、提示、翻转、重开、菜单。联机时悔棋与重开不可用。'
  ]]
];

function createRulesScene(app) {
  var scene = {
    name: 'rules',
    app: app,
    lines: [],        // {text, kind:'h'|'p'}
    scrollY: 0,
    maxScroll: 0,
    dragStartY: null,
    dragStartScroll: 0,
    back: null,
    lineHeight: 20,
    topPad: 64
  };

  scene.onEnter = function () {
    var w = app.w;
    scene.back = W.makeButton('back', 16, 16, 72, 34, '返回', 'ghost');
    // 预折行
    var ctx = app.ctx;
    scene.lines = [];
    for (var s = 0; s < SECTIONS.length; s++) {
      scene.lines.push({ text: SECTIONS[s][0], kind: 'h' });
      var paras = SECTIONS[s][1];
      for (var p = 0; p < paras.length; p++) {
        var wrapped = W.wrapText(ctx, paras[p], w - 56, 13);
        for (var i = 0; i < wrapped.length; i++) {
          scene.lines.push({ text: wrapped[i], kind: 'p' });
        }
      }
      scene.lines.push({ text: '', kind: 'gap' });
    }
    var contentH = scene.lines.length * scene.lineHeight;
    scene.maxScroll = Math.max(0, contentH - (app.h - scene.topPad - 20));
    scene.scrollY = 0;
  };

  scene.onTouch = function (type, x, y) {
    if (type === 'start') {
      if (W.hitButton(scene.back, x, y)) { app.go('menu'); return; }
      scene.dragStartY = y;
      scene.dragStartScroll = scene.scrollY;
    } else if (type === 'move') {
      if (scene.dragStartY === null) return;
      var next = scene.dragStartScroll - (y - scene.dragStartY);
      scene.scrollY = Math.max(0, Math.min(scene.maxScroll, next));
    } else {
      scene.dragStartY = null;
    }
  };

  scene.render = function (ctx, w, h) {
    W.fillBackground(ctx, w, h);
    W.drawText(ctx, '规则', w / 2, 33, 18, W.THEME.title, 'center', true);
    W.drawButton(ctx, scene.back, false);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, scene.topPad - 8, w, h - scene.topPad - 8);
    ctx.clip();
    var y = scene.topPad - scene.scrollY;
    for (var i = 0; i < scene.lines.length; i++) {
      var line = scene.lines[i];
      if (line.kind === 'h') {
        W.drawText(ctx, line.text, 28, y + 10, 16, W.THEME.title, 'left', true);
      } else if (line.kind === 'p') {
        W.drawText(ctx, line.text, 28, y + 10, 13, W.THEME.body);
      }
      y += scene.lineHeight;
    }
    ctx.restore();
  };

  return scene;
}

module.exports = createRulesScene;
