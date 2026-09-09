/**
 * 主菜单场景：难度选择 + 三种模式入口 + 规则
 */
var W = require('../ui/widgets.js');
var AI = require('../core/ai.js');

function createMenuScene(app) {
  var scene = {
    name: 'menu',
    app: app,
    buttons: [],
    seg: null,
    levels: AI.LEVEL_ORDER.map(function (k) { return AI.LEVELS[k].label; }),
    pressed: null
  };

  scene.onEnter = function () {
    var w = app.w, h = app.h;
    var pad = 28;
    var bw = w - pad * 2;
    var bh = 46;
    var gap = 14;
    var y = h * 0.34;

    scene.seg = { x: pad, y: y, w: bw, h: 40 };
    y += 40 + 26;

    scene.buttons = [
      W.makeButton('ai', pad, y, bw, bh, '人机对战'),
      W.makeButton('local', pad, y + bh + gap, bw, bh, '本地双人'),
      W.makeButton('online', pad, y + (bh + gap) * 2, bw, bh, '好友联机'),
      W.makeButton('rules', pad, y + (bh + gap) * 3, bw, bh, '查看规则', 'ghost')
    ];
  };

  scene.onTouch = function (type, x, y) {
    if (type === 'start') scene.pressed = null;
    if (type !== 'start' && type !== 'end') return;

    if (type === 'start') {
      var idx = W.hitSegmented(scene.seg.x, scene.seg.y, scene.seg.w, scene.seg.h, scene.levels, x, y);
      if (idx >= 0) {
        app.difficulty = AI.LEVEL_ORDER[idx];
        return;
      }
      for (var i = 0; i < scene.buttons.length; i++) {
        if (W.hitButton(scene.buttons[i], x, y)) { scene.pressed = scene.buttons[i].id; return; }
      }
      return;
    }

    // end：仅当抬起仍在该按钮上才触发
    var id = scene.pressed;
    scene.pressed = null;
    if (!id) return;
    for (var b = 0; b < scene.buttons.length; b++) {
      var btn = scene.buttons[b];
      if (btn.id === id && W.hitButton(btn, x, y)) {
        if (id === 'ai') app.go('board', { mode: 'ai' });
        else if (id === 'local') app.go('board', { mode: 'local' });
        else if (id === 'online') app.go('lobby');
        else if (id === 'rules') app.go('rules');
        return;
      }
    }
  };

  scene.render = function (ctx, w, h) {
    W.fillBackground(ctx, w, h);
    W.drawText(ctx, '中国象棋', w / 2, h * 0.14, 32, W.THEME.title, 'center', true);
    W.drawText(ctx, '人机对战 · 本地双人 · 好友联机', w / 2, h * 0.14 + 30, 13, W.THEME.subtitle, 'center');

    W.drawText(ctx, 'AI 难度', scene.seg.x, scene.seg.y - 14, 13, W.THEME.body);
    var sel = AI.LEVEL_ORDER.indexOf(app.difficulty);
    W.drawSegmented(ctx, scene.seg.x, scene.seg.y, scene.seg.w, scene.seg.h, scene.levels, sel);

    for (var i = 0; i < scene.buttons.length; i++) {
      W.drawButton(ctx, scene.buttons[i], scene.pressed === scene.buttons[i].id);
    }
    W.drawText(ctx, '人机与本地双人纯本地运行 · 联机需云开发', w / 2, h - 24, 11, W.THEME.subtitle, 'center');
  };

  return scene;
}

module.exports = createMenuScene;
