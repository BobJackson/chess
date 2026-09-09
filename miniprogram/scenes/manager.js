/**
 * 场景管理器（小游戏无路由栈，用场景状态机替代页面跳转）
 *
 * 场景协议：
 *   name        字符串标识
 *   onEnter(params)   进入时初始化
 *   onExit()          离开时清理（可选）
 *   onTouch(type, x, y)  type: 'start' | 'move' | 'end' | 'cancel'
 *   render(ctx, w, h, dt)  每帧绘制
 *   shouldRender(dt)  返回 false 可跳过本帧重绘（可选，默认每帧都绘）
 */
function Manager(app) {
  this.app = app;
  this.current = null;
}

/** 切换到指定场景 */
Manager.prototype.show = function (name, params) {
  var scene = this.app.createScene(name, params);
  if (!scene) return false;
  if (this.current && this.current.onExit) this.current.onExit();
  this.current = scene;
  if (scene.onEnter) scene.onEnter(params || {});
  return true;
};

/** 派发触摸事件给当前场景 */
Manager.prototype.touch = function (type, x, y) {
  if (this.current && this.current.onTouch) this.current.onTouch(type, x, y);
};

/** 驱动一帧 */
Manager.prototype.frame = function (ctx, w, h, dt) {
  var s = this.current;
  if (!s) return;
  if (s.shouldRender && s.shouldRender(dt) === false) return;
  s.render(ctx, w, h, dt);
};

module.exports = Manager;
