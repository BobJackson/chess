/**
 * 主菜单场景：难度选择 + 三种模式入口 + 规则
 */
var W = require('../ui/widgets.js');
var Chrome = require('../ui/chrome.js');
var AI = require('../core/ai.js');
var Particles = require('../ui/particles.js');

/** 桂花粒子：每瓣间隔（毫秒）与同屏上限（极淡，不抢视线） */
var PETAL_INTERVAL = 380;
var PETAL_MAX = 16;

/**
 * 松桂账本：副标题下方的比分行
 * 有账时「松 12 : 9 桂」用描题色加粗、两侧饰线；无账时低调一行小字。
 * 整行可点进账本详情页（右侧一枚小 › 提示）。
 */
function drawLedger(ctx, w, y, app) {
  var line1 = app.ledger.line();
  var line2 = app.ledger.lastLine();
  var hasGames = app.ledger.summary().total > 0;

  if (hasGames) {
    ctx.save();
    W.setFont(ctx, 14, true);
    var tw = ctx.measureText(line1).width;
    var cx = w / 2;
    ctx.strokeStyle = Chrome.PALETTE.ornament;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - tw / 2 - 32, y); ctx.lineTo(cx - tw / 2 - 12, y);
    ctx.moveTo(cx + tw / 2 + 12, y); ctx.lineTo(cx + tw / 2 + 32, y);
    ctx.stroke();
    ctx.restore();
    W.drawText(ctx, line1, cx, y, 14, W.THEME.title, 'center', true);
    if (line2) W.drawText(ctx, line2, cx, y + 18, 11, W.THEME.subtitle, 'center');
    // 可点提示：饰线之外的一枚小箭头
    W.drawText(ctx, '›', cx + tw / 2 + 44, y, 14, W.THEME.subtitle, 'center', true);
  } else {
    W.drawText(ctx, line1, w / 2, y, 12, W.THEME.subtitle, 'center');
  }
}

function createMenuScene(app) {
  var scene = {
    name: 'menu',
    app: app,
    buttons: [],
    seg: null,
    levels: AI.LEVEL_ORDER.map(function (k) { return AI.LEVELS[k].label; }),
    pressed: null,
    /** 桂花常驻粒子（松风起，桂子落——品牌气质第一眼可见） */
    fx: Particles.create(40),
    petalAcc: 300
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
      W.makeButton('rules', pad, y + (bh + gap) * 3, bw, bh, '查看规则', 'ghost'),
      W.makeButton('settings', pad, y + (bh + gap) * 4, bw, bh, '系统设置', 'ghost')
    ];

    // 账本行整体可点进详情页（比分行 + 最近局两行都在热区内）
    scene.ledgerRect = app.ledger
      ? { x: w / 2 - 120, y: h * 0.14 + 44, w: 240, h: 52 }
      : null;
  };

  scene.onTouch = function (type, x, y) {
    if (type === 'start') scene.pressed = null;
    if (type !== 'start' && type !== 'end') return;

    if (type === 'start') {
      var idx = W.hitSegmented(scene.seg.x, scene.seg.y, scene.seg.w, scene.seg.h, scene.levels, x, y);
      if (idx >= 0) {
        app.difficulty = AI.LEVEL_ORDER[idx];
        app.audio.play('tap');
        return;
      }
      if (scene.ledgerRect && app.ledger.summary().total > 0 &&
        x >= scene.ledgerRect.x && x <= scene.ledgerRect.x + scene.ledgerRect.w &&
        y >= scene.ledgerRect.y && y <= scene.ledgerRect.y + scene.ledgerRect.h) {
        scene.pressed = 'ledger';
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

    if (id === 'ledger') {
      var r = scene.ledgerRect;
      if (r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        app.audio.play('tap');
        app.go('ledger');
      }
      return;
    }

    for (var b = 0; b < scene.buttons.length; b++) {
      var btn = scene.buttons[b];
      if (btn.id === id && W.hitButton(btn, x, y)) {
        app.audio.play('tap');
        if (id === 'ai') app.go('board', { mode: 'ai' });
        else if (id === 'local') app.go('board', { mode: 'local' });
        else if (id === 'online') app.go('lobby');
        else if (id === 'rules') app.go('rules');
        else if (id === 'settings') app.go('settings');
        return;
      }
    }
  };

  scene.render = function (ctx, w, h, dt) {
    var ms = dt || 16;
    scene.petalAcc += ms;
    if (scene.petalAcc >= PETAL_INTERVAL && scene.fx.count() < PETAL_MAX) {
      scene.petalAcc = 0;
      Particles.petal(scene.fx, 12 + Math.random() * (w - 24), -12, {
        ttl: (h + 80) / 30 * 1000, alpha: 0.42
      });
    }
    scene.fx.tick(ms);

    W.fillBackground(ctx, w, h);
    W.drawText(ctx, '松风桂月', w / 2, h * 0.14, 32, W.THEME.title, 'center', true);
    W.drawText(ctx, '人机对战 · 本地双人 · 好友联机', w / 2, h * 0.14 + 30, 13, W.THEME.subtitle, 'center');

    if (app.ledger) drawLedger(ctx, w, h * 0.14 + 60, app);

    W.drawText(ctx, 'AI 难度', scene.seg.x, scene.seg.y - 14, 13, W.THEME.body);
    var sel = AI.LEVEL_ORDER.indexOf(app.difficulty);
    W.drawSegmented(ctx, scene.seg.x, scene.seg.y, scene.seg.w, scene.seg.h, scene.levels, sel);

    for (var i = 0; i < scene.buttons.length; i++) {
      W.drawButton(ctx, scene.buttons[i], scene.pressed === scene.buttons[i].id);
    }

    W.drawText(ctx, '人机与本地双人纯本地运行 · 联机需云开发', w / 2, h - 24, 11, W.THEME.subtitle, 'center');

    // 桂花落在最上层（极淡，像从屏前飘过）
    scene.fx.draw(ctx);
  };

  return scene;
}

module.exports = createMenuScene;
