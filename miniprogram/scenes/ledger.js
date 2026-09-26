/**
 * 松桂账本详情页：大比分 + 当前连胜 + 逐局历史列表
 *
 * 主菜单比分行只是门面，这里才是账本本体：
 *   - 头部：「松 12 : 9 桂 · 和 2 · 共 23 局」+ 连胜横幅（≥2 连胜才出现）
 *   - 列表：逐局记录（日期 / 模式 / 胜负 + 结果文案），最新在上，
 *           可拖动滚动（与规则页同一套交互）
 *
 * 数据源 core/ledger.js 的 history()（最近 50 局，FIFO）。
 * 空账时给一句引导文案，不展示空列表。
 */
var W = require('../ui/widgets.js');

var ROW_H = 42;

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function outcomeText(o) {
  return o === 'song' ? '松胜' : (o === 'gui' ? '桂胜' : '和棋');
}

function createLedgerScene(app) {
  var scene = {
    name: 'ledger',
    app: app,
    back: null,
    titleY: 33,
    rows: [],
    scrollY: 0,
    maxScroll: 0,
    listTop: 0,
    dragStartY: null,
    dragStartScroll: 0,
    scoreLine: '',
    metaLine: '',
    streakLine: ''
  };

  /** 超出宽度的结果文案截断加省略号 */
  function ellipsize(ctx, text, maxW) {
    if (!text) return '';
    if (ctx.measureText(text).width <= maxW) return text;
    var t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) {
      t = t.slice(0, -1);
    }
    return t + '…';
  }

  scene.onEnter = function () {
    var inset = app.topInset || 0;
    var w = app.w;
    scene.titleY = 33 + inset;
    scene.back = W.makeButton('back', 16, 16 + inset, 72, 34, '返回', 'ghost');

    var sum = app.ledger.summary();
    var streak = app.ledger.streak();

    scene.scoreLine = '松 ' + sum.song + ' : ' + sum.gui + ' 桂';
    var meta = [];
    if (sum.draws) meta.push('和 ' + sum.draws);
    meta.push('共 ' + sum.total + ' 局');
    scene.metaLine = meta.join(' · ');
    scene.streakLine = streak
      ? (streak.who === 'song' ? '松' : '桂') + ' · ' + streak.n + ' 连胜'
      : '';

    // 逐局行（最新在上）
    var games = app.ledger.history().reverse();
    var ctx = app.ctx;
    scene.rows = games.map(function (g) {
      var dt = new Date(g.t);
      return {
        main: pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate()) +
          ' · ' + (g.mode === 'online' ? '联机' : '双人') + ' · ' + outcomeText(g.outcome),
        sub: ellipsize(ctx, g.text, w - 72),
        outcome: g.outcome
      };
    });

    // 列表区域：标题区之下到屏底
    scene.listTop = scene.titleY + 96;
    var viewH = app.h - scene.listTop - 12;
    scene.maxScroll = Math.max(0, scene.rows.length * ROW_H - viewH);
    scene.scrollY = 0;
    scene.dragStartY = null;
  };

  scene.onTouch = function (type, x, y) {
    if (type === 'start') {
      if (W.hitButton(scene.back, x, y)) { app.audio.play('tap'); app.go('menu'); return; }
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

  /** 胜负的小色点：松=暖金、桂=绛红、和=灰（一眼扫胜负，与棋盘标记同色系） */
  function outcomeColor(o) {
    return o === 'song' ? '#c98a2b' : (o === 'gui' ? '#c62030' : '#8d6e63');
  }

  scene.render = function (ctx, w, h) {
    W.fillBackground(ctx, w, h);
    W.drawText(ctx, '松桂账本', w / 2, scene.titleY, 18, W.THEME.title, 'center', true);
    W.drawButton(ctx, scene.back, false);

    if (!scene.rows.length) {
      W.drawText(ctx, '还没有对局记录', w / 2, scene.listTop + 60, 14, W.THEME.subtitle, 'center');
      W.drawText(ctx, '本地双人或好友联机，终局自动入账', w / 2, scene.listTop + 84, 12, W.THEME.subtitle, 'center');
      return;
    }

    // 头部：大比分 + 元信息 + 连胜横幅
    var cx = w / 2;
    var y = scene.titleY + 34;
    W.drawText(ctx, scene.scoreLine, cx, y, 24, W.THEME.title, 'center', true);
    W.drawText(ctx, scene.metaLine, cx, y + 22, 12, W.THEME.subtitle, 'center');
    if (scene.streakLine) {
      W.drawText(ctx, scene.streakLine, cx, y + 42, 13, '#c98a2b', 'center', true);
    }

    // 列表（裁剪 + 拖动滚动）
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, scene.listTop, w, h - scene.listTop);
    ctx.clip();
    var ry = scene.listTop + 8 - scene.scrollY;
    for (var i = 0; i < scene.rows.length; i++) {
      var r = scene.rows[i];
      // 行分隔线（首行之上不画）
      if (i > 0) {
        ctx.save();
        ctx.strokeStyle = 'rgba(93,64,55,0.14)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(28, ry - 6);
        ctx.lineTo(w - 28, ry - 6);
        ctx.stroke();
        ctx.restore();
      }
      ctx.save();
      ctx.fillStyle = outcomeColor(r.outcome);
      ctx.beginPath();
      ctx.arc(34, ry + 12, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      W.drawText(ctx, r.main, 46, ry + 12, 14, W.THEME.title, 'left', true);
      if (r.sub) W.drawText(ctx, r.sub, 46, ry + 30, 11, W.THEME.subtitle);
      ry += ROW_H;
    }
    ctx.restore();
  };

  return scene;
}

module.exports = createLedgerScene;
