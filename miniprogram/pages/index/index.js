/**
 * 主页：模式与难度选择
 */
var AI = require('../../core/ai.js');

Page({
  data: {
    difficulty: 'normal',
    levels: []
  },

  onLoad: function () {
    var app = getApp();
    var levels = AI.LEVEL_ORDER.map(function (key) {
      return { key: key, label: AI.LEVELS[key].label };
    });
    this.setData({
      levels: levels,
      difficulty: (app.globalData && app.globalData.difficulty) || 'normal'
    });
  },

  onPickLevel: function (e) {
    var key = e.currentTarget.dataset.key;
    this.setData({ difficulty: key });
    getApp().globalData.difficulty = key;
  },

  onStartAI: function () {
    wx.navigateTo({
      url: '../game/game?mode=ai&difficulty=' + this.data.difficulty
    });
  },

  onStartLocal: function () {
    wx.navigateTo({ url: '../game/game?mode=local' });
  },

  onStartOnline: function () {
    wx.navigateTo({ url: '../online/online' });
  },

  onRules: function () {
    wx.navigateTo({ url: '../rules/rules' });
  }
});
