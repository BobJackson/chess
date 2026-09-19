/**
 * 音频管理器测试（node scripts/test-audio.js）
 *
 * 桩 wx.createInnerAudioContext / 存储 / 生命周期，验证：
 *   SFX 池建立、播放与复位、静音与音效开关拦截、BGM loop/暂停/恢复、开关持久化。
 */
var path = require('path');

var passed = 0;
var failed = 0;
function assert(name, actual, expected) {
  if (actual === expected) {
    passed++;
    console.log('  \x1b[32mPASS\x1b[0m  ' + name + ' = ' + JSON.stringify(actual));
  } else {
    failed++;
    console.log('  \x1b[31mFAIL\x1b[0m  ' + name +
      ' 期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  }
}
function truthy(name, v) { assert(name, !!v, true); }

// ---------------------------------------------------------------------------
// 桩 wx
// ---------------------------------------------------------------------------
var store = {};
var ctxs = [];

function makeAudioCtx() {
  var c = {
    src: '', loop: false, volume: 1, currentTime: 0,
    plays: 0, pauses: 0, stops: 0,
    play: function () { c.plays++; },
    pause: function () { c.pauses++; },
    stop: function () { c.stops++; },
    onEnded: function () {}
  };
  ctxs.push(c);
  return c;
}

global.wx = {
  createInnerAudioContext: makeAudioCtx,
  getStorageSync: function (k) { return store[k]; },
  setStorageSync: function (k, v) { store[k] = v; }
};

var audio = require(path.join(__dirname, '..', 'miniprogram', 'ui', 'audio.js'));

console.log('\n[1] 初始化：SFX 池与 BGM');
audio.init();
(function () {
  assert('SFX 池数量', Object.keys(audio.sfx).length, 7);
  truthy('BGM 上下文已建', audio.bgm);
  assert('BGM 源', audio.bgm.src, '/audio/bgm.mp3');
  assert('BGM 循环', audio.bgm.loop, true);
  assert('落子音效源', audio.sfx.move.src, '/audio/move.wav');
})();

console.log('\n[2] 播放与复位');
(function () {
  var a = audio.sfx.move;
  var before = a.plays;
  assert('play 返回 true', audio.play('move'), true);
  assert('播放次数 +1', a.plays, before + 1);
  truthy('播放前 stop 复位', a.stops >= 1);
  assert('未知音效返回 false', audio.play('nope'), false);
})();

console.log('\n[3] 静音拦截');
(function () {
  var a = audio.sfx.move;
  audio.setMuted(true);
  var before = a.plays;
  assert('静音时 play 返回 false', audio.play('move'), false);
  assert('静音时不播放', a.plays, before);
  assert('静音已持久化', store['chess_muted'], 1);
  audio.setMuted(false);
  assert('取消静音后可播放', audio.play('move'), true);
  assert('取消静音持久化', store['chess_muted'], 0);
})();

console.log('\n[4] 音效开关');
(function () {
  var a = audio.sfx.tap;
  audio.setSfxOn(false);
  assert('关音效时 play 返回 false', audio.play('tap'), false);
  assert('关音效已持久化', store['chess_sfx_off'], 1);
  audio.setSfxOn(true);
  assert('开音效后可播放', audio.play('tap'), true);
})();

console.log('\n[5] BGM 控制');
(function () {
  var b = audio.bgm;
  var p0 = b.plays, q0 = b.pauses;
  assert('startBgm 返回 true', audio.startBgm(), true);
  assert('BGM 播放 +1', b.plays, p0 + 1);
  audio.pauseBgm();
  assert('BGM 暂停 +1', b.pauses, q0 + 1);

  audio.setBgmOn(false);
  assert('关音乐已持久化', store['chess_bgm_off'], 1);
  assert('关音乐后 startBgm 返回 false', audio.startBgm(), false);
  audio.setBgmOn(true);
  assert('开音乐后恢复播放', b.plays, p0 + 2);
})();

console.log('\n[6] 杀法语音');
(function () {
  var before = ctxs.length;
  assert('未播过时无语音上下文', Object.keys(audio.mateVoice).length, 0);

  assert('朗读马后炮', audio.playMate('mahoupao'), true);
  assert('按需创建一个上下文', ctxs.length - before, 1);
  var c = audio.mateVoice.mahoupao;
  truthy('语音上下文已缓存', c);
  assert('语音源', c.src, '/audio/mate-mahoupao.m4a');
  assert('播放一次', c.plays, 1);

  // 同一 key 复用上下文，不重复创建
  audio.playMate('mahoupao');
  assert('重复朗读不新建上下文', ctxs.length - before, 1);
  assert('重复朗读再播一次', c.plays, 2);
  assert('复播前先 stop 复位', c.stops, 2);
  assert('复播前时间归零', c.currentTime, 0);

  var n = ctxs.length;
  audio.playMate('shuangchecuo');
  assert('换一个 key 另建上下文', ctxs.length - n, 1);
  assert('双车错语音源', audio.mateVoice.shuangchecuo.src, '/audio/mate-shuangchecuo.m4a');

  assert('空 key 不播放', audio.playMate(''), false);
  assert('空 key 不新建上下文', ctxs.length - n, 1);

  // 关音效后不朗读，也不建上下文
  audio.setSfxOn(false);
  var m = ctxs.length;
  assert('关音效后不朗读', audio.playMate('wocaoma'), false);
  assert('关音效后不建上下文', ctxs.length - m, 0);
  audio.setSfxOn(true);

  // 静音同理
  audio.setMuted(true);
  var k = ctxs.length;
  assert('静音后不朗读', audio.playMate('wocaoma'), false);
  assert('静音后不建上下文', ctxs.length - k, 0);
  audio.setMuted(false);
})();

console.log('\n[7] 杀法语音资产齐备');
(function () {
  var fs = require('fs');
  var Mate = require(path.join(__dirname, '..', 'miniprogram', 'core', 'mate.js'));
  var dir = path.join(__dirname, '..', 'miniprogram', 'audio');

  var missing = [];
  var empty = [];
  Mate.MATE_PATTERNS.forEach(function (p) {
    var f = path.join(dir, 'mate-' + p.key + '.m4a');
    if (!fs.existsSync(f)) missing.push(p.key);
    else if (fs.statSync(f).size < 1024) empty.push(p.key);
  });

  assert('每种杀法都有语音文件', missing.join(',') || '无缺失', '无缺失');
  assert('语音文件都不是空壳', empty.join(',') || '无异常', '无异常');
  // 清单与磁盘必须一一对应，多出来的文件说明有改名漏删
  var onDisk = fs.readdirSync(dir).filter(function (f) {
    return f.indexOf('mate-') === 0 && /\.m4a$/.test(f);
  });
  assert('磁盘上的语音数量与清单一致', onDisk.length, Mate.MATE_PATTERNS.length);
})();

console.log('\n----------------------------------------');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) {
  console.log('\x1b[31m音频测试未通过\x1b[0m\n');
  process.exit(1);
}
console.log('\x1b[32m音频全部测试通过\x1b[0m\n');
