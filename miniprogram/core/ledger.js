/**
 * 松桂账本（纯 JS，无 wx 依赖，可单测）
 *
 * 二人专属的胜负记录：松（本机方）vs 桂（对面的人）。
 * 只记「人对人」的局——人机对战是练棋，不入账：
 *   本地双人：红方 = 松，黑方 = 桂（红先，长幼有序）
 *   好友联机：本机方 = 松，对方 = 桂（账本是各存各的，各记各的视角）
 *
 * 存储通过注入的 storage 适配器（{ get(key), set(key, value) }），
 * 小游戏里接 wx.getStorageSync / setStorageSync，测试里给内存对象。
 * 存储读写失败时降级为纯内存账本，绝不抛异常影响对局。
 */

var C = require('./constants.js');

/** wx storage 的键名（带版本号，结构变更时换键即自然迁移） */
var KEY = 'songgui-ledger-v1';

/** 账本结构版本 */
var VERSION = 1;

function blank() {
  return { v: VERSION, total: 0, song: 0, gui: 0, draws: 0, last: null };
}

/** 容忍脏数据：字段缺失或类型不对就回退到空账本 */
function sanitize(data) {
  if (!data || typeof data !== 'object') return blank();
  var d = blank();
  if (typeof data.total === 'number' && data.total >= 0) d.total = data.total | 0;
  if (typeof data.song === 'number' && data.song >= 0) d.song = data.song | 0;
  if (typeof data.gui === 'number' && data.gui >= 0) d.gui = data.gui | 0;
  if (typeof data.draws === 'number' && data.draws >= 0) d.draws = data.draws | 0;
  if (data.last && typeof data.last === 'object' && typeof data.last.t === 'number') {
    d.last = {
      t: data.last.t,
      mode: data.last.mode === 'online' ? 'online' : 'local',
      outcome: data.last.outcome === 'song' || data.last.outcome === 'gui' ? data.last.outcome : 'draw',
      text: typeof data.last.text === 'string' ? data.last.text : ''
    };
  }
  return d;
}

/**
 * 由终局结果算出该记谁一笔（纯函数，便于测试）
 *
 * @param {string} mode 'ai' | 'local' | 'online'
 * @param {object} result Game 的 result（winner: 0 红 / 1 黑 / -1 和）
 * @param {number} [humanSide] 联机时本机方阵营
 * @returns {?string} 'song' | 'gui' | 'draw'；不入账（人机/未知模式/无结果）返回 null
 */
function outcomeFor(mode, result, humanSide) {
  if (!result) return null;
  if (mode !== 'local' && mode !== 'online') return null;
  var w = result.winner;
  if (w !== C.RED && w !== C.BLACK) return 'draw';
  if (mode === 'local') return w === C.RED ? 'song' : 'gui';
  return w === humanSide ? 'song' : 'gui';
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

/**
 * 创建账本
 * @param {{get:function(string):*, set:function(string, *)}} storage
 */
function create(storage) {
  var cache = null;

  function load() {
    if (cache) return cache;
    var raw = null;
    try { raw = storage.get(KEY); } catch (e) { raw = null; }
    cache = sanitize(raw);
    return cache;
  }

  function save() {
    try { storage.set(KEY, cache); } catch (e) { /* 存储不可用时只留内存账 */ }
  }

  return {
    KEY: KEY,

    /**
     * 记一局。返回记账结果（'song'/'gui'/'draw'），不入账时返回 null。
     * @param {{mode:string, result:object, humanSide?:number, when?:number}} args
     */
    record: function (args) {
      var outcome = outcomeFor(args.mode, args.result, args.humanSide);
      if (!outcome) return null;
      var d = load();
      d.total++;
      if (outcome === 'song') d.song++;
      else if (outcome === 'gui') d.gui++;
      else d.draws++;
      d.last = {
        t: args.when || Date.now(),
        mode: args.mode,
        outcome: outcome,
        text: args.result && typeof args.result.text === 'string' ? args.result.text : ''
      };
      save();
      return outcome;
    },

    /** 汇总（返回内部数据的快照副本） */
    summary: function () {
      var d = load();
      return {
        total: d.total, song: d.song, gui: d.gui, draws: d.draws,
        last: d.last ? {
          t: d.last.t, mode: d.last.mode, outcome: d.last.outcome, text: d.last.text
        } : null
      };
    },

    /** 主菜单第一行：比分 */
    line: function () {
      var d = load();
      if (!d.total) return '松桂账本 · 待首局开枰';
      var s = '松 ' + d.song + ' : ' + d.gui + ' 桂';
      if (d.draws) s += ' · 和 ' + d.draws;
      return s;
    },

    /** 主菜单第二行：最近一局（无则空串） */
    lastLine: function () {
      var d = load();
      if (!d.last) return '';
      var who = d.last.outcome === 'song' ? '松胜' : (d.last.outcome === 'gui' ? '桂胜' : '和棋');
      var mode = d.last.mode === 'online' ? '联机' : '双人';
      var dt = new Date(d.last.t);
      return '上局 ' + who + ' · ' + mode + ' · ' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate());
    },

    /** 清零（换赛季/重新开始） */
    reset: function () {
      cache = blank();
      save();
    },

    /** 测试用：丢弃缓存强制重读存储 */
    _reload: function () { cache = null; }
  };
}

module.exports = {
  KEY: KEY,
  VERSION: VERSION,
  create: create,
  outcomeFor: outcomeFor
};
