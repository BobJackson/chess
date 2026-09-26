/**
 * 音频管理器（小游戏）
 *
 * - BGM：单个 InnerAudioContext，loop 循环，切后台暂停/回前台恢复；
 *        多曲目管理（BGM_TRACKS），当前曲目持久化，切曲即时生效
 * - SFX：预建对象池复用，避免每次播放新建上下文
 * - 开关：音乐 / 音效独立开关，静音与开关状态用 wx.setStorageSync 持久化
 * - 平台限制：iOS 需用户首次交互后才能出声，故 BGM 由入口在首次触摸时启动
 *
 * 无 wx 环境（node 测试）下 init 后所有方法安全 no-op 或走桩。
 */

var SFX_FILES = {
  move: '/audio/move.wav',
  capture: '/audio/capture.wav',
  check: '/audio/check.wav',
  win: '/audio/win.wav',
  lose: '/audio/lose.wav',
  tap: '/audio/tap.wav',
  undo: '/audio/undo.wav'
};

/**
 * BGM 曲目库：松风（合成主题曲，gen-bgm.js）/ 桂月（实录氛围，修复循环版）
 * 增曲：加文件 + 这里加一行，设置页的配乐选项自动跟随
 */
var BGM_TRACKS = [
  { key: 'songfeng', name: '松风', src: '/audio/bgm-songfeng.m4a' },
  { key: 'guiyue', name: '桂月', src: '/audio/bgm-guiyue.m4a' }
];

/** 杀法语音的路径前缀：/audio/mate-<key>.m4a，key 来自 core/mate.js */
var MATE_VOICE_PREFIX = '/audio/mate-';

function AudioMgr() {
  this.inited = false;
  this.unavailable = false;
  this.bgm = null;
  this.sfx = {};
  /** 杀法语音按需创建并缓存，key -> InnerAudioContext */
  this.mateVoice = {};
  this.muted = false;
  this.bgmOn = true;
  this.sfxOn = true;
  /** 当前曲目在 BGM_TRACKS 的下标 */
  this.track = 0;
}

AudioMgr.prototype.init = function () {
  if (this.inited) return this;
  this.inited = true;
  if (typeof wx === 'undefined' || !wx.createInnerAudioContext) {
    this.unavailable = true;
    return this;
  }
  try {
    this.muted = !!wx.getStorageSync('chess_muted');
    this.bgmOn = wx.getStorageSync('chess_bgm_off') ? false : true;
    this.sfxOn = wx.getStorageSync('chess_sfx_off') ? false : true;
    var t = wx.getStorageSync('chess_bgm_track');
    if (typeof t === 'number' && BGM_TRACKS[t]) this.track = t;
  } catch (e) { /* 存储不可用时用缺省值 */ }

  var self = this;
  Object.keys(SFX_FILES).forEach(function (k) {
    var a = wx.createInnerAudioContext();
    a.src = SFX_FILES[k];
    a.volume = 0.9;
    self.sfx[k] = a;
  });

  this.bgm = wx.createInnerAudioContext();
  this.bgm.src = BGM_TRACKS[this.track].src;
  this.bgm.loop = true;
  this.bgm.volume = 0.4;
  return this;
};

/** 播放音效；静音或关闭音效时 no-op */
AudioMgr.prototype.play = function (name) {
  if (this.unavailable || this.muted || !this.sfxOn) return false;
  var a = this.sfx[name];
  if (!a) return false;
  try {
    a.stop();
    a.currentTime = 0;
    a.play();
  } catch (e) { return false; }
  return true;
};

/**
 * 朗读杀法名（终局绝杀时播放）
 *
 * 音频按需创建并缓存：杀法有十几种，初始化时全部建上下文既浪费也可能触到
 * 平台对同时存在的音频实例数的限制。
 *
 * @param {string} key 杀法的 ASCII key，见 core/mate.js 的 MATE_PATTERNS
 */
AudioMgr.prototype.playMate = function (key) {
  if (this.unavailable || this.muted || !this.sfxOn) return false;
  if (!key || typeof wx === 'undefined' || !wx.createInnerAudioContext) return false;

  var a = this.mateVoice[key];
  if (!a) {
    try {
      a = wx.createInnerAudioContext();
      a.src = MATE_VOICE_PREFIX + key + '.m4a';
      a.volume = 0.95;
      this.mateVoice[key] = a;
    } catch (e) { return false; }
  }

  try {
    a.stop();
    a.currentTime = 0;
    a.play();
  } catch (e) { return false; }
  return true;
};

AudioMgr.prototype.startBgm = function () {
  if (this.unavailable || !this.bgmOn || this.muted || !this.bgm) return false;
  try { this.bgm.play(); } catch (e) { return false; }
  return true;
};

AudioMgr.prototype.pauseBgm = function () {
  if (!this.bgm) return;
  try { this.bgm.pause(); } catch (e) {}
};

AudioMgr.prototype.resumeBgm = function () {
  if (this.bgmOn && !this.muted) this.startBgm();
};

AudioMgr.prototype.setMuted = function (m) {
  this.muted = !!m;
  this._store('chess_muted', this.muted ? 1 : 0);
  if (this.muted) this.pauseBgm();
  else this.resumeBgm();
  return this.muted;
};

AudioMgr.prototype.setBgmOn = function (on) {
  this.bgmOn = !!on;
  this._store('chess_bgm_off', this.bgmOn ? 0 : 1);
  if (this.bgmOn) this.startBgm(); else this.pauseBgm();
  return this.bgmOn;
};

AudioMgr.prototype.setSfxOn = function (on) {
  this.sfxOn = !!on;
  this._store('chess_sfx_off', this.sfxOn ? 0 : 1);
  return this.sfxOn;
};

/**
 * 切换 BGM 曲目（设置页调用）；正在播放时换源并立即续播
 * @param {number|string} idx BGM_TRACKS 下标或 key
 */
AudioMgr.prototype.setTrack = function (idx) {
  if (typeof idx === 'string') {
    for (var i = 0; i < BGM_TRACKS.length; i++) {
      if (BGM_TRACKS[i].key === idx) { idx = i; break; }
    }
  }
  if (typeof idx !== 'number' || !BGM_TRACKS[idx]) return this.track;
  this.track = idx;
  this._store('chess_bgm_track', idx);
  if (this.bgm) {
    var playing = this.bgmOn && !this.muted;
    try { this.bgm.stop(); } catch (e) {}
    this.bgm.src = BGM_TRACKS[idx].src;
    if (playing) this.startBgm();
  }
  return this.track;
};

/** 当前曲目名（设置页显示用） */
AudioMgr.prototype.trackName = function () {
  return BGM_TRACKS[this.track].name;
};

AudioMgr.prototype._store = function (k, v) {
  try { wx.setStorageSync(k, v); } catch (e) {}
};

module.exports = new AudioMgr();
module.exports.SFX_FILES = SFX_FILES;
module.exports.BGM_TRACKS = BGM_TRACKS;
module.exports.MATE_VOICE_PREFIX = MATE_VOICE_PREFIX;
