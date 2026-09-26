/**
 * 设置场景：所有开关与选项的统一入口
 *
 * 主菜单不再为每个设置加按钮——音乐/音效开关、配乐切换、先后手
 * 都收进这一页；以后新增设置项只需在 ROWS 加一行（label + 分段项 + get/set）。
 *
 * 每行 = 左侧标签 + 右侧分段选择器（开关也是 [关|开] 两段），
 * 视觉语言与规则页一致（返回按钮 + 标题 + 行式内容）。
 */
var W = require('../ui/widgets.js');
var Themes = require('../ui/themes.js');
var C = require('../core/constants.js');

function createSettingsScene(app) {
  var scene = {
    name: 'settings',
    app: app,
    back: null,
    rows: []
  };

  /**
   * 行定义：集中描述，渲染与命中都按它驱动。
   * items 为分段标签；get() 返回当前选中下标；set(idx) 应用变更。
   */
  function buildRows() {
    return [
      {
        id: 'bgm', label: '音乐',
        items: ['关', '开'],
        get: function () { return app.audio.bgmOn ? 1 : 0; },
        set: function (i) { app.audio.setBgmOn(i === 1); }
      },
      {
        id: 'track', label: '配乐',
        items: app.audio.BGM_TRACKS.map(function (t) { return t.name; }),
        get: function () { return app.audio.track; },
        set: function (i) { app.audio.setTrack(i); },
        note: '松风 · 合成主题曲 / 桂月 · 实录氛围'
      },
      {
        id: 'sfx', label: '音效',
        items: ['关', '开'],
        get: function () { return app.audio.sfxOn ? 1 : 0; },
        set: function (i) { app.audio.setSfxOn(i === 1); }
      },
      {
        id: 'side', label: '先后手',
        items: ['执红先手', '让先执黑'],
        get: function () { return app.humanSide === C.BLACK ? 1 : 0; },
        set: function (i) { app.humanSide = i === 1 ? C.BLACK : C.RED; },
        note: '人机/本地生效；联机由房间分配'
      },
      {
        id: 'theme', label: '主题',
        items: Themes.THEMES.map(function (t) { return t.name; }),
        get: function () { return Themes.indexOf(Themes.key()); },
        set: function (i) { Themes.setTheme(Themes.THEMES[i].key); },
        note: '松桂 · 米白暖木 / 紫金夜 · 深空紫金'
      }
    ];
  }

  scene.onEnter = function () {
    var inset = app.topInset || 0;
    scene.back = W.makeButton('back', 16, 16 + inset, 72, 34, '返回', 'ghost');
    scene.titleY = 33 + inset;
    scene.rows = buildRows();

    // 行布局：标签在左，分段选择器在右
    var w = app.w;
    var pad = 28;
    var segW = Math.min(220, w * 0.56);
    var y = 96 + inset;
    for (var i = 0; i < scene.rows.length; i++) {
      var r = scene.rows[i];
      r.seg = { x: w - pad - segW, y: y, w: segW, h: 38 };
      r.labelY = y + 19;
      r.noteY = r.note ? y + 52 : null;
      y += r.note ? 74 : 58;
    }
  };

  scene.onTouch = function (type, x, y) {
    if (type !== 'start') return;
    if (W.hitButton(scene.back, x, y)) { app.audio.play('tap'); app.go('menu'); return; }
    for (var i = 0; i < scene.rows.length; i++) {
      var r = scene.rows[i];
      var idx = W.hitSegmented(r.seg.x, r.seg.y, r.seg.w, r.seg.h, r.items, x, y);
      if (idx >= 0) {
        r.set(idx);
        app.audio.play('tap');
        return;
      }
    }
  };

  scene.render = function (ctx, w, h) {
    W.fillBackground(ctx, w, h);
    W.drawText(ctx, '系统设置', w / 2, scene.titleY, 18, W.THEME.title, 'center', true);
    W.drawButton(ctx, scene.back, false);

    for (var i = 0; i < scene.rows.length; i++) {
      var r = scene.rows[i];
      W.drawText(ctx, r.label, 28, r.labelY, 15, W.THEME.title, 'left', true);
      W.drawSegmented(ctx, r.seg.x, r.seg.y, r.seg.w, r.seg.h, r.items, r.get());
      if (r.note) W.drawText(ctx, r.note, 28, r.noteY, 11, W.THEME.subtitle);
    }
  };

  return scene;
}

module.exports = createSettingsScene;
