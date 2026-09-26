/**
 * BGM 合成脚本（node scripts/gen-bgm.js [输出wav路径]）
 *
 * 不依赖任何音频素材，纯数学合成一曲中国风背景音乐（44100Hz 单声道 16bit）。
 * 默认输出 /tmp/bgm-candidate.wav 供试听对比；确认替换时：
 *   1. afconvert -f m4af -d aac -b 56000 -q 127 /tmp/bgm-candidate.wav miniprogram/audio/bgm.m4a
 *   2. 循环接缝已在曲内处理（见文末 crossfadeLoop），替换后无需再加工
 *
 * 作曲设计（《松风桂月》主题）：
 *   - D 宫五声音阶（宫商角徵羽 = D E F# A B），66 BPM，16 小节 A/B 两段
 *   - 古筝旋律（长音带揉弦）+ 分解琶音 + 低音拨弦 + 箫长音垫底
 *   - A 段呈示、B 段抬高三度再回落，尾音 D5 长音与开头呼应（为循环设计）
 *   - 曲尾与曲首做 2s 等功率交叉淡化，循环点无接缝、无空窗
 */

var SR = 44100;
var OUT = process.argv[2] || '/tmp/bgm-candidate.wav';

var BPM = 66;
var BEAT = 60 / BPM;          // 每拍秒数 ≈ 0.909
var BAR = BEAT * 4;
var BARS = 16;
var TAIL = 2.2;               // 结尾混响余量（交叉淡化前）
var XFADE = 2.0;              // 循环交叉淡化时长

// D 宫五声音阶频率表
var F = {
  G2: 98.00, A2: 110.00, B2: 123.47, D3: 146.83, E3: 164.81, Fs3: 185.00,
  G3: 196.00, A3: 220.00, B3: 246.94, D4: 293.66, E4: 329.63, Fs4: 369.99,
  A4: 440.00, B4: 493.88,
  D5: 587.33, E5: 659.26, Fs5: 739.99, A5: 880.00, B5: 987.77, D6: 1174.66
};

function buffer(seconds) { return new Float64Array(Math.floor(SR * seconds)); }

// ---------------------------------------------------------------------------
// 乐器
// ---------------------------------------------------------------------------

/**
 * 古筝拨弦 v2（实录化）：
 * - 失谐泛音列 + 快速起音 + 指数衰减；长音后半段揉弦（≈5.5Hz，渐入）
 * - 力度→亮度耦合：重音高频衰减慢（更亮）、轻音更闷——真实弦乐的核心特征
 * - 起音 2ms 软化 + 极轻指甲声，去掉"八音盒"式的硬瞬态
 */
function pluck(buf, t, freq, durBeats, amp) {
  var s0 = Math.floor(t * SR);
  var dur = Math.max(durBeats * BEAT * 2.4, 1.0);
  var n = Math.floor(dur * SR);
  var partials = [1, 2.0, 3.01, 4.03, 5.02];
  var gains = [1, 0.40, 0.18, 0.08, 0.035];
  // 力度（0.6~1.15）：越重高频越亮、余音越长
  var bright = Math.min(1.2, Math.max(0.6, amp / 0.34));
  var vib = durBeats >= 1.2;
  for (var i = 0; i < n && s0 + i < buf.length; i++) {
    var tt = i / SR;
    if (tt < 0.002) tt = tt * (tt / 0.002); // 2ms 软化起音
    var v = 0;
    for (var p = 0; p < partials.length; p++) {
      var dec = 3.0 + p * (2.6 - bright); // 高泛音衰减快；bright 大则慢
      var env = Math.exp(-tt * dec);
      if (p === 0 && env < 0.001) { v = -1; break; }
      var pm = 0;
      if (vib) {
        var ramp = Math.min(1, Math.max(0, (tt - 0.35) / 0.6));
        pm = 0.9 * ramp * Math.sin(2 * Math.PI * 5.5 * tt);
      }
      v += gains[p] * env * Math.sin(2 * Math.PI * freq * partials[p] * tt + pm);
    }
    if (v === -1) break;
    buf[s0 + i] += amp * v;
  }
  // 指甲瞬态：比 v1 轻得多，仅 2ms
  var nn = Math.floor(0.002 * SR);
  for (var k = 0; k < nn && s0 + k < buf.length; k++) {
    buf[s0 + k] += amp * 0.12 * (1 - k / nn) * (Math.random() * 2 - 1);
  }
}

/**
 * 箫 v2：起音带 ~40 音分上滑（吹奏的"够音"过程）、呼吸声更重、
 * 句尾音高微落；基音 + 弱二泛音，慢起音慢释放，长音微颤
 */
function xiao(buf, t, freq, durBeats, amp) {
  var s0 = Math.floor(t * SR);
  var dur = durBeats * BEAT;
  var n = Math.floor(dur * SR);
  var atk = 0.4, rel = Math.min(0.7, dur * 0.45);
  var prevNoise = 0;
  for (var i = 0; i < n && s0 + i < buf.length; i++) {
    var tt = i / SR;
    var env = Math.min(1, tt / atk) * Math.min(1, (dur - tt) / rel);
    // 起音上滑：f*0.96 → f，90ms 到位；句尾 200ms 下滑 ~15 音分
    var slide = tt < 0.09 ? (0.96 + 0.04 * tt / 0.09)
      : (tt > dur - 0.2 ? 1 - 0.015 * (tt - (dur - 0.2)) / 0.2 : 1);
    var pm = 0.35 * Math.sin(2 * Math.PI * 4.8 * tt) * Math.min(1, tt / 1.2);
    var f = freq * slide;
    var v = Math.sin(2 * Math.PI * f * tt + pm) +
      0.22 * Math.sin(2 * Math.PI * f * 2 * tt + pm);
    // 气声：一阶低通噪声（比白噪柔），幅度跟随
    prevNoise = prevNoise * 0.82 + (Math.random() * 2 - 1) * 0.18;
    buf[s0 + i] += amp * env * (v * 0.82 + prevNoise * 0.55);
  }
}

/** 刮奏（glissando）：五声音阶快速上行一串，结尾点缀 */
function gliss(buf, t, fromFreq, toFreq, notes, spanBeats, amp) {
  var scale = [];
  var ratios = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2, 9 / 4, 5 / 2, 3, 10 / 3, 4];
  for (var r = 0; r < ratios.length; r++) {
    var f = fromFreq * ratios[r];
    if (f >= fromFreq * 0.99 && f <= toFreq * 1.01) scale.push(f);
  }
  var step = spanBeats * BEAT / notes;
  for (var k = 0; k < notes; k++) {
    pluck(buf, t + k * step, scale[k % scale.length], 0.3, amp * (1 - k / (notes * 2.2)));
  }
}

// ---------------------------------------------------------------------------
// 谱面
// ---------------------------------------------------------------------------

/**
 * 旋律：{ bar, beat, f, d } = 小节、起拍（0 起）、音、拍长
 * A 段 bars 1-8 呈示；B 段 bars 9-16 抬高再回落；尾音 D5 与开头呼应（循环点）
 */
var MELODY = [
  // a1
  { bar: 0, beat: 0, f: 'D5', d: 1 }, { bar: 0, beat: 1, f: 'E5', d: 1 }, { bar: 0, beat: 2, f: 'Fs5', d: 2 },
  { bar: 1, beat: 0, f: 'A5', d: 1 }, { bar: 1, beat: 1, f: 'Fs5', d: 1 }, { bar: 1, beat: 2, f: 'E5', d: 1 }, { bar: 1, beat: 3, f: 'D5', d: 1 },
  { bar: 2, beat: 0, f: 'E5', d: 1.5 }, { bar: 2, beat: 1.5, f: 'Fs5', d: 0.5 }, { bar: 2, beat: 2, f: 'A5', d: 2 },
  { bar: 3, beat: 0, f: 'B5', d: 2 }, { bar: 3, beat: 2, f: 'A5', d: 1 }, { bar: 3, beat: 3, f: 'Fs5', d: 1 },
  // a2
  { bar: 4, beat: 0, f: 'D5', d: 1 }, { bar: 4, beat: 1, f: 'E5', d: 1 }, { bar: 4, beat: 2, f: 'Fs5', d: 1 }, { bar: 4, beat: 3, f: 'A5', d: 1 },
  { bar: 5, beat: 0, f: 'B5', d: 2 }, { bar: 5, beat: 2, f: 'A5', d: 1 }, { bar: 5, beat: 3, f: 'Fs5', d: 1 },
  { bar: 6, beat: 0, f: 'E5', d: 1.5 }, { bar: 6, beat: 1.5, f: 'D5', d: 0.5 }, { bar: 6, beat: 2, f: 'E5', d: 1 }, { bar: 6, beat: 3, f: 'Fs5', d: 1 },
  { bar: 7, beat: 0, f: 'D5', d: 3 },
  // b1（抬高）
  { bar: 8, beat: 0, f: 'A5', d: 1 }, { bar: 8, beat: 1, f: 'B5', d: 1 }, { bar: 8, beat: 2, f: 'D6', d: 2 },
  { bar: 9, beat: 0, f: 'B5', d: 1 }, { bar: 9, beat: 1, f: 'A5', d: 1 }, { bar: 9, beat: 2, f: 'Fs5', d: 2 },
  { bar: 10, beat: 0, f: 'A5', d: 1.5 }, { bar: 10, beat: 1.5, f: 'Fs5', d: 0.5 }, { bar: 10, beat: 2, f: 'E5', d: 1 }, { bar: 10, beat: 3, f: 'Fs5', d: 1 },
  { bar: 11, beat: 0, f: 'E5', d: 2 }, { bar: 11, beat: 2, f: 'D5', d: 2 },
  // b2（回落，与 a2 呼应）
  { bar: 12, beat: 0, f: 'D5', d: 1 }, { bar: 12, beat: 1, f: 'E5', d: 1 }, { bar: 12, beat: 2, f: 'Fs5', d: 1 }, { bar: 12, beat: 3, f: 'A5', d: 1 },
  { bar: 13, beat: 0, f: 'B5', d: 1.5 }, { bar: 13, beat: 1.5, f: 'A5', d: 0.5 }, { bar: 13, beat: 2, f: 'Fs5', d: 1 }, { bar: 13, beat: 3, f: 'E5', d: 1 },
  { bar: 14, beat: 0, f: 'E5', d: 1 }, { bar: 14, beat: 1, f: 'Fs5', d: 1 }, { bar: 14, beat: 2, f: 'E5', d: 1 }, { bar: 14, beat: 3, f: 'D5', d: 1 },
  { bar: 15, beat: 0, f: 'D5', d: 3.5 }
];

/** 每小节的低音根音（第 1 拍），部分小节第 3 拍补五度 */
var BASS = [
  ['D3'], ['B2'], ['G2'], ['A2'],
  ['D3'], ['B2'], ['G2', 'A2'], ['D3'],
  ['G2'], ['A2'], ['B2'], ['G2'],
  ['D3'], ['B2'], ['G2', 'A2'], ['D3']
];

/** 箫长音：每两小节一根（中音区垫底） */
var XIAO = [
  { bar: 0, f: 'D4' }, { bar: 2, f: 'A3' }, { bar: 4, f: 'B3' }, { bar: 6, f: 'A3' },
  { bar: 8, f: 'G3' }, { bar: 10, f: 'A3' }, { bar: 12, f: 'D4' }, { bar: 14, f: 'D4' }
];

/** 琶音填充：指定小节的末拍，和弦内音上行 3 音 */
var ARP = [
  { bar: 1, notes: ['D4', 'Fs4', 'A4'] },
  { bar: 3, notes: ['B3', 'D4', 'Fs4'] },
  { bar: 5, notes: ['D4', 'Fs4', 'A4'] },
  { bar: 9, notes: ['G3', 'B3', 'D4'] },
  { bar: 11, notes: ['A3', 'D4', 'E4'] },
  { bar: 13, notes: ['B3', 'D4', 'Fs4'] }
];

// ---------------------------------------------------------------------------
// 合成
// ---------------------------------------------------------------------------

function barBeat(bar, beat) { return bar * BAR + beat * BEAT; }

/**
 * 乐句级动态曲线（实录化的关键之一）：四句一起伏，B 段推到顶再收
 * 下标记小节，值为该小节的力度系数
 */
var DYNAMICS = [0.88, 0.92, 0.96, 1.00, 0.94, 0.98, 0.92, 0.86,
  1.00, 1.08, 1.12, 1.04, 0.98, 1.02, 0.94, 0.84];

/** 人性化：重拍稍强、节拍 ±12ms 抖动、力度 ±10% 抖动——机械感的解药 */
function human(bar, beat, amp) {
  var accent = beat === 0 ? 1.08 : (beat === 2 ? 1.03 : 0.97);
  return {
    t: barBeat(bar, beat) + (Math.random() - 0.5) * 0.024,
    v: amp * DYNAMICS[bar] * accent * (0.9 + Math.random() * 0.2)
  };
}

function compose() {
  var total = BARS * BAR + TAIL;
  var buf = buffer(total);

  var i, h;
  // 旋律（古筝）：每音过人性化
  for (i = 0; i < MELODY.length; i++) {
    var m = MELODY[i];
    h = human(m.bar, m.beat, 0.34);
    pluck(buf, h.t, F[m.f], m.d, h.v);
  }
  // 琶音填充（轻，靠后）
  for (i = 0; i < ARP.length; i++) {
    var a = ARP[i];
    for (var k = 0; k < a.notes.length; k++) {
      h = human(a.bar, 3 + k * 0.33, 0.12);
      pluck(buf, h.t, F[a.notes[k]], 0.4, h.v);
    }
  }
  // 低音拨弦：第 1 拍根音；有两个音的小节第 3 拍补第二个
  for (i = 0; i < BASS.length; i++) {
    h = human(i, 0, 0.26);
    pluck(buf, h.t, F[BASS[i][0]], 1.5, h.v);
    if (BASS[i][1]) {
      h = human(i, 2, 0.20);
      pluck(buf, h.t, F[BASS[i][1]], 1.5, h.v);
    }
  }
  // 箫长音（句读之间留呼吸：不人性化对齐，自然错开 30ms）
  for (i = 0; i < XIAO.length; i++) {
    xiao(buf, barBeat(XIAO[i].bar, 0) + 0.03, F[XIAO[i].f], 8, 0.15);
  }
  // 结尾刮奏（bar 8 与 bar 16 收束处）
  gliss(buf, barBeat(7, 3), F.D4, F.A5, 7, 0.9, 0.10);
  gliss(buf, barBeat(15, 3.2), F.D4, F.D6, 9, 0.7, 0.09);

  return buf;
}

// ---------------------------------------------------------------------------
// 母带链：混响 → 低通暖意 → 软饱和（实录化的另一半）
// ---------------------------------------------------------------------------

/**
 * 简化 Freeverb 混响（单声道）：4 个并联带阻尼梳状滤波 + 2 个串联全通。
 * 房间感是"实录味"最大的来源——干声直出怎么调音色都是合成感。
 */
function reverb(buf, wet) {
  var combs = [1116, 1188, 1277, 1356];
  var feedback = 0.82, damp = 0.28;
  var out = new Float64Array(buf.length);
  var c, d, i;
  var wetSig = new Float64Array(buf.length);

  for (c = 0; c < combs.length; c++) {
    var len = combs[c];
    var line = new Float64Array(len);
    var lp = 0; // 阻尼低通状态
    for (i = 0; i < buf.length; i++) {
      var idx = i % len;
      var y = line[idx];
      lp = y * (1 - damp) + lp * damp;
      line[idx] = buf[i] + lp * feedback;
      wetSig[i] += y * 0.25;
    }
  }
  // 全通（打散回声密度）
  var aps = [225, 341];
  for (var a = 0; a < aps.length; a++) {
    var alen = aps[a];
    var aline = new Float64Array(alen);
    for (i = 0; i < wetSig.length; i++) {
      var ai = i % alen;
      var ay = aline[ai];
      aline[ai] = wetSig[i] + ay * 0.5;
      wetSig[i] = ay - wetSig[i] * 0.5;
    }
  }
  for (i = 0; i < buf.length; i++) out[i] = buf[i] * (1 - wet) + wetSig[i] * wet;
  return out;
}

/** 一阶低通（≈9kHz）：抹掉合成高频的毛刺 */
function lowpass(buf, cutoff) {
  var rc = 1 / (2 * Math.PI * cutoff);
  var dt = 1 / SR;
  var alpha = dt / (rc + dt);
  var prev = 0;
  for (var i = 0; i < buf.length; i++) {
    prev = prev + alpha * (buf[i] - prev);
    buf[i] = prev;
  }
  return buf;
}

/** 软饱和：轻微 tanh，增加"被录下来"的粘合感 */
function saturate(buf, drive) {
  for (var i = 0; i < buf.length; i++) {
    buf[i] = Math.tanh(buf[i] * drive) / Math.tanh(drive);
  }
  return buf;
}

/** 循环接缝：曲尾 XFADE 秒与曲首等功率交叉淡化，循环总长减 XFADE */
function crossfadeLoop(buf) {
  var X = Math.floor(XFADE * SR);
  var M = buf.length - X;
  var out = new Float64Array(M);
  for (var i = 0; i < X; i++) {
    var g = i / X;
    out[i] = buf[buf.length - X + i] * Math.cos(g * Math.PI / 2) +
      buf[i] * Math.sin(g * Math.PI / 2);
  }
  for (i = X; i < M; i++) out[i] = buf[i];
  return out;
}

function normalize(buf, peak) {
  var max = 0;
  for (var i = 0; i < buf.length; i++) max = Math.max(max, Math.abs(buf[i]));
  var g = (peak || 0.89) / max;
  for (i = 0; i < buf.length; i++) buf[i] *= g;
  return buf;
}

function writeWav(file, buf) {
  var fs = require('fs');
  var n = buf.length;
  var data = Buffer.alloc(44 + n * 2);
  data.write('RIFF', 0); data.writeUInt32LE(36 + n * 2, 4); data.write('WAVE', 8);
  data.write('fmt ', 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22); data.writeUInt32LE(SR, 24); data.writeUInt32LE(SR * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(n * 2, 40);
  for (var i = 0; i < n; i++) {
    var v = Math.max(-1, Math.min(1, buf[i]));
    data.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, data);
}

var dry = compose();
var wet = reverb(dry, 0.30);          // 30% 湿声：小房间，不糊
lowpass(wet, 9000);
saturate(wet, 1.15);
var raw = normalize(crossfadeLoop(wet), 0.89);
writeWav(OUT, raw);
console.log('已生成 ' + OUT + '（' + (raw.length / SR).toFixed(1) + 's，循环接缝已处理）');
console.log('试听满意后：afconvert -f m4af -d aac -b 56000 -q 127 ' + OUT + ' miniprogram/audio/bgm-songfeng.m4a');
