/**
 * 粒子系统（纯 JS，无 wx 依赖，可单测）
 *
 * 为「电影级」打击感与氛围服务：
 *   chip  木屑——吃子落点迸溅，旋转小方块，受重力
 *   petal 桂花——菜单常驻飘落 / 吃子震落，带风摆与自旋
 *   ring  冲击波环——将军时在将被处扩散
 *   drop  墨滴——绝杀落款时溅落
 *   dot   金点——通用点缀
 *
 * 固定池、帧内零分配：池满时新粒子直接丢弃（氛围粒子不值得顶掉旧的）。
 * 随机源可注入（setRng），测试可以完全确定性。
 */

var DEFAULT_MAX = 64;

function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

/**
 * @param {number} [max=64] 池容量
 */
function create(max) {
  var cap = Math.max(1, max || DEFAULT_MAX);
  var slots = [];
  for (var i = 0; i < cap; i++) {
    slots.push({
      alive: false, shape: 'dot',
      x: 0, y: 0, vx: 0, vy: 0,
      rot: 0, vr: 0, size: 2, width: 1.5,
      color: '#ffffff', alpha: 1,
      life: 0, ttl: 1000,
      gravity: 0, drag: 0,
      swayAmp: 0, swaySpeed: 0, swayPhase: 0,
      grow: 0
    });
  }
  var rng = Math.random;

  function spawn(p) {
    for (var i = 0; i < cap; i++) {
      var s = slots[i];
      if (s.alive) continue;
      s.alive = true;
      s.shape = p.shape || 'dot';
      s.x = p.x || 0; s.y = p.y || 0;
      s.vx = p.vx || 0; s.vy = p.vy || 0;
      s.rot = p.rot || 0; s.vr = p.vr || 0;
      s.size = p.size === undefined ? 2 : p.size;
      s.width = p.width === undefined ? 1.5 : p.width;
      s.color = p.color || '#ffffff';
      s.alpha = p.alpha === undefined ? 1 : p.alpha;
      s.life = 0;
      s.ttl = Math.max(1, p.ttl || 1000);
      s.gravity = p.gravity || 0;
      s.drag = p.drag || 0;
      s.swayAmp = p.swayAmp || 0;
      s.swaySpeed = p.swaySpeed || 0;
      s.swayPhase = p.swayPhase || 0;
      s.grow = p.grow || 0;
      return true;
    }
    return false;
  }

  function tick(dtMs) {
    var dt = (dtMs || 16) / 1000;
    for (var i = 0; i < cap; i++) {
      var s = slots[i];
      if (!s.alive) continue;
      s.life += dtMs || 16;
      if (s.life >= s.ttl) { s.alive = false; continue; }
      s.vy += s.gravity * dt;
      if (s.drag > 0) {
        var k = Math.max(0, 1 - s.drag * dt);
        s.vx *= k; s.vy *= k;
      }
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      if (s.swayAmp > 0) {
        s.x += Math.sin(s.swayPhase + s.life / 1000 * s.swaySpeed) * s.swayAmp * dt;
      }
      s.rot += s.vr * dt;
    }
  }

  /** 粒子透明度：花瓣淡入淡出，其余线性淡出 */
  function alphaOf(s) {
    var p = s.life / s.ttl;
    if (s.shape === 'petal') {
      var fin = clamp01(p / 0.15);
      var fout = clamp01((1 - p) / 0.4);
      return s.alpha * fin * fout;
    }
    return s.alpha * (1 - p);
  }

  function draw(ctx) {
    for (var i = 0; i < cap; i++) {
      var s = slots[i];
      if (!s.alive) continue;
      var a = alphaOf(s);
      if (a <= 0.004) continue;
      ctx.save();
      ctx.globalAlpha = Math.min(1, a);
      if (s.shape === 'ring') {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = Math.max(0.6, s.width * (1 - s.life / s.ttl * 0.6));
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.size + s.grow * (s.life / 1000), 0, Math.PI * 2);
        ctx.stroke();
      } else if (s.shape === 'chip') {
        ctx.translate(s.x, s.y);
        ctx.rotate(s.rot);
        ctx.fillStyle = s.color;
        ctx.fillRect(-s.size / 2, -s.size * 0.3, s.size, s.size * 0.6);
      } else if (s.shape === 'petal') {
        ctx.translate(s.x, s.y);
        ctx.rotate(s.rot);
        ctx.scale(1, 0.55);
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(0, 0, s.size, 0, Math.PI * 2);
        ctx.fill();
      } else if (s.shape === 'drop') {
        ctx.translate(s.x, s.y);
        ctx.scale(0.7, 1.15);
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(0, 0, s.size, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  function count() {
    var n = 0;
    for (var i = 0; i < cap; i++) if (slots[i].alive) n++;
    return n;
  }

  function clear() {
    for (var i = 0; i < cap; i++) slots[i].alive = false;
  }

  return {
    spawn: spawn,
    tick: tick,
    draw: draw,
    count: count,
    clear: clear,
    setRng: function (fn) { rng = typeof fn === 'function' ? fn : Math.random; },
    _rand: function () { return rng(); },
    _cap: cap
  };
}

// ---------------------------------------------------------------------------
// 发射器
// ---------------------------------------------------------------------------

/**
 * 迸溅：从一点向外飞出 n 粒（吃子木屑、落款墨滴）
 * @param {object} opts {
 *   n, shape, colors: string[], speed, spread(弧度，默认全向 2π),
 *   dirX, dirY（偏向方向，默认无偏向）, size:[min,max], ttl:[min,max],
 *   gravity, drag, vr
 * }
 */
function burst(pool, x, y, opts) {
  opts = opts || {};
  var n = opts.n || 6;
  var colors = opts.colors || ['#ffffff'];
  var speed = opts.speed || 200;
  var sizes = opts.size || [2, 4];
  var ttls = opts.ttl || [400, 700];
  var biased = typeof opts.dirX === 'number' || typeof opts.dirY === 'number';
  var baseAng = biased ? Math.atan2(opts.dirY || 0, opts.dirX || 0) : 0;
  var spread = opts.spread === undefined ? Math.PI * 2 : opts.spread;

  var rnd = pool._rand;
  var spawned = 0;
  for (var i = 0; i < n; i++) {
    var ang = biased
      ? baseAng + (rnd() - 0.5) * spread
      : rnd() * Math.PI * 2;
    var v = speed * (0.5 + rnd() * 0.7);
    var ok = pool.spawn({
      shape: opts.shape || 'chip',
      x: x, y: y,
      vx: Math.cos(ang) * v,
      vy: Math.sin(ang) * v - (opts.up || 0),
      size: sizes[0] + rnd() * (sizes[1] - sizes[0]),
      ttl: ttls[0] + rnd() * (ttls[1] - ttls[0]),
      color: colors[(rnd() * colors.length) | 0],
      alpha: opts.alpha === undefined ? 0.9 : opts.alpha,
      gravity: opts.gravity || 0,
      drag: opts.drag || 0,
      rot: rnd() * Math.PI * 2,
      vr: (opts.vr === undefined ? 6 : opts.vr) * (rnd() < 0.5 ? -1 : 1)
    });
    if (ok) spawned++;
  }
  return spawned;
}

/**
 * 一瓣桂花：缓慢下落 + 风摆 + 自旋
 * @param {object} opts { color, alpha, size, vy, swayAmp, ttl }
 */
function petal(pool, x, y, opts) {
  opts = opts || {};
  var rnd = pool._rand;
  var vy = opts.vy || (24 + rnd() * 18);
  return pool.spawn({
    shape: 'petal',
    x: x, y: y,
    vx: (rnd() - 0.5) * 8,
    vy: vy,
    size: opts.size || (2.6 + rnd() * 1.8),
    color: opts.color || 'rgba(233,200,120,0.9)',
    alpha: opts.alpha === undefined ? 0.5 : opts.alpha,
    ttl: opts.ttl || 9000,
    swayAmp: opts.swayAmp || (10 + rnd() * 8),
    swaySpeed: 1.6 + rnd() * 1.6,
    swayPhase: rnd() * Math.PI * 2,
    rot: rnd() * Math.PI * 2,
    vr: (rnd() - 0.5) * 2.4
  });
}

/**
 * 冲击波环：在 (x,y) 处扩散一圈（将军警示）
 * @param {object} opts { color, size(起始半径), grow(扩散速度 px/s), ttl, width }
 */
function ring(pool, x, y, opts) {
  opts = opts || {};
  return pool.spawn({
    shape: 'ring',
    x: x, y: y,
    size: opts.size || 16,
    color: opts.color || 'rgba(233,60,48,0.9)',
    alpha: opts.alpha === undefined ? 0.85 : opts.alpha,
    ttl: opts.ttl || 450,
    grow: opts.grow || 260,
    width: opts.width || 2.4
  });
}

module.exports = {
  create: create,
  burst: burst,
  petal: petal,
  ring: ring
};
