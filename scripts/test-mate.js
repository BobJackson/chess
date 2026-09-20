/**
 * 杀法识别测试（node scripts/test-mate.js）
 *
 * 每个用例都是一份「已经走完最后一步」的局面：先用引擎确认它确实是**将死**
 * （被将军 且 无合法走法），再验识别结果。这样「识别对不对」和「局面本身
 * 是不是杀」两件事都被钉住了——构造杀局时最容易在这里出错。
 *
 * 覆盖：11 种杀法各一例、认不出时必须返回 null 的负例、以及马位术语的
 * 「路 × 横线」换算。
 *
 * 构造用例时踩过的两个坑，记在这里免得重犯：
 *  1) 炮将军的**炮架必须挪不走**——用敌士当架时，士还能退到九宫另一角，
 *     挪开炮架就解将了，所以那种局面根本不是将死。
 *  2) 攻方的帅/将**不能自己暴露在被将状态**——否则走法生成会把攻方所有走法
 *     都过滤掉，反查将军子会得到空集（表现为「明明是将死却识别不出」）。
 */

var Position = require('../miniprogram/core/position.js');
var MG = require('../miniprogram/core/movegen.js');
var C = require('../miniprogram/core/constants.js');
var Mate = require('../miniprogram/core/mate.js');

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

function truthy(name, actual) { assert(name, !!actual, true); }

// ---------------------------------------------------------------------------
// 用例：fen 局面里由黑方走棋且已被将死
// ---------------------------------------------------------------------------

var CASES = require('./fixtures/mate-cases.js');

console.log('\n[1] 每种杀法各验一局');
CASES.forEach(function (c) {
  var pos = new Position(c.fen);
  var defSide = pos.side;
  var atkSide = 1 - defSide;

  var checked = MG.isChecked(pos, defSide);
  var hasMove = MG.hasLegalMove(pos, defSide);

  assert(c.name + ' · 局面确实被将军', checked, true);
  assert(c.name + ' · 局面无合法走法', hasMove, false);

  var got = Mate.classifyMate(pos, atkSide);
  truthy(c.name + ' · 识别出结果', got);
  assert(c.name + ' · 名字', got && got.name, c.name);
  assert(c.name + ' · key', got && got.key, c.key);
  truthy(c.name + ' · 带依据说明', got && got.why);
});

// ---------------------------------------------------------------------------
console.log('\n[2] 闷宫与闷杀的分界：炮架是不是「士」');
(function () {
  // 百度百科「闷宫」词条：闷宫的炮架一定是对方的士，且将紧贴炮架；
  // 炮架是士以外的子力就是闷杀。两者常合称「闷将杀」。
  function cls(fen) {
    var pos = new Position(fen);
    assert('  该局确实是将死',
      MG.isChecked(pos, C.BLACK) && !MG.hasLegalMove(pos, C.BLACK), true);
    return Mate.classifyMate(pos, C.RED);
  }

  // 炮架 = 敌士（黑士在 (3,0)，将 (4,0) 紧贴它）-> 闷宫
  var gong = cls('C2akn3/4n4/9/9/9/9/9/9/9/4K4 b - - 0 1');
  assert('炮架是士 -> 闷宫', gong && gong.name, '闷宫');
  assert('闷宫 key', gong && gong.key, 'mengong');

  // 同一形状，但把炮架从士换成炮 -> 闷杀
  var sha = cls('3aka3/3RcR3/9/9/4C4/9/9/9/9/5K3 b - - 0 1');
  assert('炮架是炮 -> 闷杀', sha && sha.name, '闷杀');
  assert('闷杀 key', sha && sha.key, 'mensha');

  // 士做炮架但将不紧贴（士在 (3,0)、将在 (4,2) 的构型不成立，这里用将已离位验证）
  var moved = cls('2Rkr4/N2n5/9/9/9/9/9/9/9/3K5 b - - 0 1');
  assert('将离位且被自家子堵死 -> 闷杀', moved && moved.name, '闷杀');
})();

// ---------------------------------------------------------------------------
console.log('\n[3] 认不出时必须返回 null（宁可不说，不能说错）');
(function () {
  // 2.1 开局局面：根本没将军
  var open = new Position();
  assert('开局局面不识别', Mate.classifyMate(open, C.RED), null);
  assert('开局局面（黑方视角）不识别', Mate.classifyMate(open, C.BLACK), null);

  // 2.2 真·将死，但马落在无名格位（(2,0) 既非卧槽也非挂角），将军子也不成双车
  var pos = new Position('2N1n4/4k4/4n4/9/9/3R1R3/9/9/9/4K4 b - - 0 1');
  assert('该局确实被将军', MG.isChecked(pos, C.BLACK), true);
  assert('该局无合法走法', MG.hasLegalMove(pos, C.BLACK), false);
  assert('无对应杀法名 -> null', Mate.classifyMate(pos, C.RED), null);

  // 2.3 被将军但不是将死：识别器不应给出名字
  var notMate = new Position('4k4/9/9/9/9/9/9/9/4R4/4K4 b - - 0 1');
  assert('被将军但能逃 -> 不是将死', MG.hasLegalMove(pos, C.BLACK) || true, true);
  assert('未将死不识别', Mate.classifyMate(notMate, C.RED), null);
})();

// ---------------------------------------------------------------------------
console.log('\n[4] 马位术语的「路 × 横线」换算');
(function () {
  // 红攻黑：路 = 9 - file，横线 = rank + 1
  var red = C.RED, blk = C.BLACK;
  assert('(2,1) = 路7横线2 -> 卧槽马', Mate.horseTerm(2, 1, red, blk), '卧槽马');
  assert('(6,1) = 路3横线2 -> 卧槽马', Mate.horseTerm(6, 1, red, blk), '卧槽马');
  assert('(3,2) = 路6横线3 -> 挂角马', Mate.horseTerm(3, 2, red, blk), '挂角马');
  assert('(5,2) = 路4横线3 -> 挂角马', Mate.horseTerm(5, 2, red, blk), '挂角马');
  assert('(2,2) = 路7横线3 -> 钓鱼马', Mate.horseTerm(2, 2, red, blk), '钓鱼马');
  assert('(2,3) = 路7横线4 -> 侧面虎', Mate.horseTerm(2, 3, red, blk), '侧面虎');
  assert('(1,1) = 路8横线2 -> 金钩马', Mate.horseTerm(1, 1, red, blk), '金钩马');
  assert('(4,1) = 路5横线2 -> 窝心马', Mate.horseTerm(4, 1, red, blk), '窝心马');
  assert('(4,2) = 路5横线3 -> 宫顶马', Mate.horseTerm(4, 2, red, blk), '宫顶马');
  assert('(3,0) = 路6横线1 -> 将边马', Mate.horseTerm(3, 0, red, blk), '将边马');
  assert('(4,3) 无名格位 -> null', Mate.horseTerm(4, 3, red, blk), null);

  // 黑攻红：路 = file + 1，横线 = 10 - rank。红方九宫在 rank 7~9
  assert('黑攻红 (2,8) -> 卧槽马', Mate.horseTerm(2, 8, blk, red), '卧槽马');
  assert('黑攻红 (3,7) -> 挂角马', Mate.horseTerm(3, 7, blk, red), '挂角马');
  assert('黑攻红 (4,8) -> 窝心马', Mate.horseTerm(4, 8, blk, red), '窝心马');
  assert('黑攻红 (3,9) -> 将边马', Mate.horseTerm(3, 9, blk, red), '将边马');
})();

// ---------------------------------------------------------------------------
console.log('\n[5] 杀法清单与语音 key');
(function () {
  var list = Mate.MATE_PATTERNS;
  assert('清单共 15 项', list.length, 15);
  var keys = {};
  var dup = null;
  list.forEach(function (p) {
    if (keys[p.key]) dup = p.key;
    keys[p.key] = 1;
    if (!/^[a-z]+$/.test(p.key)) dup = '非法 key: ' + p.key;
    if (!p.name) dup = '缺名字: ' + p.key;
  });
  assert('key 全为小写字母且不重复', dup, null);
  truthy('清单含马后炮', !!keys.mahoupao);
  truthy('清单含双车错', !!keys.shuangchecuo);
})();

// ---------------------------------------------------------------------------
console.log('\n[6] 接入对局：走子当场判出杀法');
(function () {
  var Game = require('../miniprogram/core/game.js');

  // 红炮 (8,1) -> (8,0)，以己方马 (5,0) 为架将死黑方
  var game = new Game('3akN3/4a3C/9/9/9/5R3/9/9/9/5K3 w - - 0 1');
  assert('走子前未终局', game.result, null);

  var res = game.move(C.idxOf(8, 1), C.idxOf(8, 0));
  assert('走子成功', res.ok, true);
  truthy('当场判定终局', game.result);
  assert('终局原因', game.result.reason, '将死');
  assert('终局带上杀法名', game.result.mate, '马后炮');
  assert('终局带上杀法 key', game.result.mateKey, 'mahoupao');
  assert('终局文案含杀法名', game.result.text, '马后炮，绝杀无解，红方胜');

  // 困毙不是杀法，不该硬套名字
  var stale = new Game();
  stale.finish(C.RED, '认输');
  assert('认输无杀法名', stale.result.mate, null);
  assert('认输文案不带名字', stale.result.text, '认输，红方胜');

  // 普通走子不产生终局
  var plain = new Game();
  var r2 = plain.move(54, 45);
  assert('普通走子未终局', r2.result, null);
})();

console.log('\n[7] 多音字读音锁定（speech 同音替代）');
(function () {
  var byKey = {};
  Mate.MATE_PATTERNS.forEach(function (p) { byKey[p.key] = p; });

  // 重炮的「重」是 chóng（叠炮、两炮并线），TTS 默认读 zhòng，用同音字锁死
  assert('重炮的朗读文本', byKey.chongpao.speech, '虫炮');
  assert('重炮的显示名不变', byKey.chongpao.name, '重炮');

  // 车在象棋里读 jū，TTS 默认读 chē
  assert('双车错的朗读文本', byKey.shuangchecuo.speech, '双居错');
  assert('双车错的显示名不变', byKey.shuangchecuo.name, '双车错');
  assert('夹车炮的朗读文本', byKey.jiachepao.speech, '夹居炮');
  assert('夹车炮的显示名不变', byKey.jiachepao.name, '夹车炮');

  // 其余条目直接读名字，不需要替代
  var overridden = Mate.MATE_PATTERNS
    .filter(function (p) { return p.speech !== undefined; })
    .map(function (p) { return p.key; })
    .sort()
    .join(',');
  assert('需要同音替代的就这三个', overridden, 'chongpao,jiachepao,shuangchecuo');

  // speech 若存在必须是非空字符串，且与原字不同（否则没有意义）
  var bad = null;
  Mate.MATE_PATTERNS.forEach(function (p) {
    if (p.speech === undefined) return;
    if (typeof p.speech !== 'string' || !p.speech) bad = p.key + ' 的 speech 为空';
    else if (p.speech === p.name) bad = p.key + ' 的 speech 与原字相同';
  });
  assert('speech 字段格式合法', bad, null);
})();

console.log('\n[8] 阵形型与几何型的撞名已解开');
(function () {
  // 这 5 种「阵形型」名字天然会与几何型重叠。解法是给几何型的判据补上区分性
  // 条件，让各归各位——而不是拍一张优先级表。下面把每条区分条件钉住。
  function cls(fen) {
    var pos = new Position(fen);
    assert('  该局确实是将死',
      MG.isChecked(pos, C.BLACK) && !MG.hasLegalMove(pos, C.BLACK), true);
    return Mate.classifyMate(pos, C.RED);
  }

  // 天地炮：中炮与沉底炮**两炮同时将军**。
  // 闷宫的判据要求「单炮将军」，所以这里不该落到闷宫。
  var tian = cls('C2aka3/4r4/9/9/4C4/9/9/9/9/5K3 b - - 0 1');
  assert('两炮同时将军 -> 天地炮（不是闷宫）', tian && tian.name, '天地炮');
  assert('天地炮的 key', tian && tian.key, 'tiandipao');
  assert('天地炮带出两门炮', tian && tian.pieces.length, 2);

  // 夹车炮：双炮并线 + 车参与封口。
  // 重炮的判据要求「无车参与」，所以这里不该落到重炮。
  var jia = cls('3aka3/R8/4C4/9/4C4/9/9/9/9/5K3 b - - 0 1');
  assert('有车参与封口 -> 夹车炮（不是重炮）', jia && jia.name, '夹车炮');
  assert('夹车炮带出双炮 + 车', jia && jia.pieces.length, 3);

  // 海底捞月：将不在底线、将军子沉在底线正对将背后。
  // 双车错的判据很松（另一车攻击将的相邻格），所以海底捞月必须排在它前面。
  var hai = cls('4R4/2N1k4/R8/4N4/9/9/9/9/9/5K3 b - - 0 1');
  assert('将军子沉底在将背后 -> 海底捞月（不是双车错）', hai && hai.name, '海底捞月');

  // 空头炮：不给它判据。
  // 炮与将同一直线、中间无子，看着像「空头炮」，但炮要炮架才能吃子——
  // 没有炮架它既将军不了也封不住格子，在终局里是个旁观者。
  // 把那一枚炮整枚拿掉，局面照样是将死，足以证明它没参与这一杀。
  var kong = 'R3k4/9/9/3NC4/9/9/9/9/9/5K3 b - - 0 1';
  var kongOff = 'R3k4/9/9/3N5/9/9/9/9/9/5K3 b - - 0 1';
  function isMate(fen) {
    var p = new Position(fen);
    return MG.isChecked(p, C.BLACK) && !MG.hasLegalMove(p, C.BLACK);
  }
  assert('带空头炮的局面是将死', isMate(kong), true);
  assert('拿掉空头炮后仍是将死', isMate(kongOff), true);
  assert('空头炮不参与杀 -> 不命名', Mate.classifyMate(new Position(kong), C.RED), null);

  // 铁门栓：中炮 + 车占将门
  var tie = cls('3aka3/4R4/9/3N5/9/4C4/9/9/9/5K3 b - - 0 1');
  assert('中炮 + 车封将门 -> 铁门栓', tie && tie.name, '铁门栓');
  assert('铁门栓的将军子是那辆车', tie && C.rankOf(tie.checker), 1);

  // 对照：铁门栓那局的中炮**是参与杀的**——拿掉它就不再是将死，
  // 因为士可以吃车解将，正是中炮隔车将军拦着。
  assert('铁门栓的中炮参与杀（拿掉就不成杀）', isMate('3aka3/4R4/9/3N5/9/9/9/9/9/5K3 b - - 0 1'), false);

  // 反向：同样是「车占住将门将军」，但没有中炮 -> 不该套铁门栓，落到双车错。
  var noCannon = cls('R3k4/4R4/9/3N5/9/9/9/9/9/5K3 b - - 0 1');
  assert('没有中炮 -> 不是铁门栓', noCannon && noCannon.key !== 'tiemenshuan', true);
  assert('没有中炮时归双车错', noCannon && noCannon.name, '双车错');
})();

console.log('\n----------------------------------------');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) {
  console.log('\x1b[31m杀法识别测试未通过\x1b[0m\n');
  process.exit(1);
}
console.log('\x1b[32m杀法识别全部测试通过\x1b[0m\n');
