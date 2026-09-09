/**
 * 音效合成脚本（node scripts/gen-sfx.js）
 *
 * 不依赖任何外部音频素材，用纯数学合成一组中国象棋音效的 WAV（22050Hz 单声道 16bit），
 * 输出到 miniprogram/audio/。音色取向：木质棋盘的"笃"声 + 五声音阶提示音。
 *
 * 生成物：move / capture / check / win / lose / tap / undo
 * 重新生成：npm run gen:sfx
 */
var fs = require('fs');
var path = require('path');

var SR = 22050;
var OUT = path.join(__dirname, '..', 'miniprogram', 'audio');

function buffer(seconds) {
  var n = Math.floor(SR * seconds);
  return new Float64Array(n);
}

/** 指数衰减正弦泛音 */
function tone(buf, start, dur, freq, amp, decay, phase) {
  var s0 = Math.floor(start * SR);
  var n = Math.floor(dur * SR);
  phase = phase || 0;
  for (var i = 0; i < n && s0 + i < buf.length; i++) {
    var t = i / SR;
    var env = Math.exp(-t * decay);
    buf[s0 + i] += amp * env * Math.sin(2 * Math.PI * freq * t + phase);
  }
}

/** 指数衰减白噪（模拟木质敲击的瞬态） */
function noise(buf, start, dur, amp, decay) {
  var s0 = Math.floor(start * SR);
  var n = Math.floor(dur * SR);
  for (var i = 0; i < n && s0 + i < buf.length; i++) {
    var t = i / SR;
    buf[s0 + i] += amp * Math.exp(-t * decay) * (Math.random() * 2 - 1);
  }
}

/** 简单软限幅，防爆音 */
function normalize(buf, peak) {
  var max = 0;
  for (var i = 0; i < buf.length; i++) max = Math.max(max, Math.abs(buf[i]));
  if (max === 0) return buf;
  var g = (peak || 0.85) / max;
  for (i = 0; i < buf.length; i++) buf[i] *= g;
  return buf;
}

function writeWav(name, buf) {
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
  fs.writeFileSync(path.join(OUT, name + '.wav'), data);
}

// ---------------------------------------------------------------------------
// 各音效
// ---------------------------------------------------------------------------

/** 落子：清脆木质"笃" */
function makeMove() {
  var b = buffer(0.12);
  noise(b, 0, 0.012, 0.5, 900);
  tone(b, 0, 0.10, 1750, 0.55, 55);
  tone(b, 0, 0.07, 2620, 0.25, 70);
  tone(b, 0.002, 0.09, 880, 0.20, 60);
  return b;
}

/** 吃子：更沉的闷响 + 短促摩擦 */
function makeCapture() {
  var b = buffer(0.22);
  noise(b, 0, 0.02, 0.6, 500);
  tone(b, 0, 0.18, 320, 0.6, 26);
  tone(b, 0, 0.14, 150, 0.45, 22);
  tone(b, 0.01, 0.10, 640, 0.2, 40);
  return b;
}

/** 将军：两声上行的警示钟 */
function makeCheck() {
  var b = buffer(0.5);
  tone(b, 0, 0.22, 784, 0.5, 14);      // G5
  tone(b, 0, 0.22, 1568, 0.18, 16);
  tone(b, 0.14, 0.3, 1046.5, 0.5, 12); // C6
  tone(b, 0.14, 0.3, 2093, 0.15, 14);
  return b;
}

/** 胜：上行五声琶音 + 锣韵 */
function makeWin() {
  var b = buffer(1.2);
  var seq = [523.25, 587.33, 659.25, 783.99, 880]; // C D E G A
  for (var i = 0; i < seq.length; i++) {
    tone(b, i * 0.11, 0.5, seq[i], 0.4, 7);
    tone(b, i * 0.11, 0.35, seq[i] * 2, 0.12, 9);
  }
  tone(b, 0.55, 0.65, 196, 0.4, 5);   // 锣的低韵 G3
  tone(b, 0.55, 0.5, 392, 0.18, 6);
  return b;
}

/** 负：下行滑落 + 低锣 */
function makeLose() {
  var b = buffer(1.0);
  var seq = [659.25, 587.33, 523.25, 392];
  for (var i = 0; i < seq.length; i++) {
    tone(b, i * 0.13, 0.45, seq[i], 0.38, 8);
  }
  tone(b, 0.5, 0.5, 146.83, 0.4, 5);  // D3 低锣
  return b;
}

/** 按钮：极短轻击 */
function makeTap() {
  var b = buffer(0.06);
  noise(b, 0, 0.008, 0.4, 1200);
  tone(b, 0, 0.05, 2400, 0.4, 90);
  return b;
}

/** 悔棋：柔和的上挑 tick */
function makeUndo() {
  var b = buffer(0.14);
  tone(b, 0, 0.10, 900, 0.35, 40);
  tone(b, 0.03, 0.10, 1350, 0.3, 40);
  noise(b, 0, 0.006, 0.25, 1500);
  return b;
}

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

var makers = {
  move: makeMove, capture: makeCapture, check: makeCheck,
  win: makeWin, lose: makeLose, tap: makeTap, undo: makeUndo
};
Object.keys(makers).forEach(function (k) {
  writeWav(k, normalize(makers[k](), 0.85));
  var size = fs.statSync(path.join(OUT, k + '.wav')).size;
  console.log('  audio/' + k + '.wav  ' + (size / 1024).toFixed(1) + ' KB');
});
console.log('音效合成完成');
