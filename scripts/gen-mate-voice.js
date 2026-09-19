/**
 * 杀法语音合成脚本（node scripts/gen-mate-voice.js）
 *
 * 为每种杀法生成一段中文朗读音频，终局时播出来——不只是弹窗显示名字。
 * 朗读内容就是杀法名本身（如「马后炮」）。
 *
 * 只依赖 macOS 自带的 say + afconvert，不需要任何外部素材或云服务：
 *   say -v Tingting          中文（普通话）合成
 *   afconvert -f m4af -d aac 转成 22050Hz 单声道 AAC（约 8~10KB/条）
 *
 * 输出到 miniprogram/audio/mate-<key>.m4a，文件名用 mate.js 里的 ASCII key，
 * 避免中文文件名进小游戏包。清单以 core/mate.js 为单一数据源，改名不必改这里。
 *
 * 重新生成：npm run gen:voice
 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var execFileSync = require('child_process').execFileSync;

var Mate = require('../miniprogram/core/mate.js');

var VOICE = 'Tingting';
var OUT = path.join(__dirname, '..', 'miniprogram', 'audio');
var BITRATE = 32000;

function has(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'pipe' });
    return true;
  } catch (e) {
    return false;
  }
}

if (process.platform !== 'darwin' || !has('say') || !has('afconvert')) {
  console.error('本脚本依赖 macOS 自带的 say 与 afconvert，当前环境不可用。');
  console.error('已生成的音频在 miniprogram/audio/mate-*.m4a，可直接使用，无需重跑。');
  process.exit(1);
}

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-voice-'));

function synth(text, outFile) {
  var aiff = path.join(tmp, path.basename(outFile) + '.aiff');
  execFileSync('say', ['-v', VOICE, '-o', aiff, text], { stdio: 'pipe' });
  execFileSync('afconvert', [
    '-f', 'm4af', '-d', 'aac', '-b', String(BITRATE), aiff, outFile
  ], { stdio: 'pipe' });
}

var total = 0;
var done = 0;

Mate.MATE_PATTERNS.forEach(function (p) {
  var outFile = path.join(OUT, 'mate-' + p.key + '.m4a');
  // speech 是同音替代文本，用来锁死多音字读音（如 重炮 -> 虫炮）；显示仍是 name
  var text = p.speech || p.name;
  try {
    synth(text, outFile);
  } catch (e) {
    console.error('  \x1b[31m失败\x1b[0m  ' + p.name + '：' + e.message);
    return;
  }
  var size = fs.statSync(outFile).size;
  total += size;
  done++;
  var mark = p.speech ? '  (朗读作「' + p.speech + '」)' : '';
  console.log('  \x1b[32mOK\x1b[0m  ' + p.name + '  ->  ' +
    path.basename(outFile) + '  (' + size + ' B)' + mark);
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n共 ' + done + '/' + Mate.MATE_PATTERNS.length + ' 条，合计 ' +
  (total / 1024).toFixed(1) + ' KB，输出目录 miniprogram/audio/');
