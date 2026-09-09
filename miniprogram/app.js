/**
 * 小程序入口
 *
 * 全局只保留最少状态；对局逻辑全部在 core/ 与 ui/ 的纯 JS 模块中，
 * 页面仅负责把 Canvas 触摸事件与渲染循环接上去。
 * 联机会话（session）与传输（transport）放在 globalData，供大厅页与对局页交接。
 */
App({
  globalData: {
    // 最近一次选择的难度，供对局页缺省使用
    difficulty: 'normal',
    // 联机会话与传输，由大厅页创建、对局页消费
    session: null,
    transport: null,
    cloudReady: false
  },
  onLaunch: function () {
    if (wx.cloud && wx.cloud.init) {
      try {
        wx.cloud.init({ traceUser: true });
        this.globalData.cloudReady = true;
      } catch (e) {
        this.globalData.cloudReady = false;
      }
    }
  }
});
