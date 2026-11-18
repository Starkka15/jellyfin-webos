const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ctx = {
  window: {},
  localStorage: {getItem:key=>key === 'jf.miniBridge' ? 'http://192.168.50.20:18099/v1/PublicFixtureCapability0123456789' : ''}
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app/source/Compatibility.js'), 'utf8'), ctx);
const decide = ctx.JF.choosePlayback;
const cap = 'PublicFixtureCapability0123456789';
assert.strictEqual(ctx.JF.bridgeAddress('http://192.168.50.20:18099/v1/' + cap + '/'),
  'http://192.168.50.20:18099/v1/' + cap);
for (const host of ['203.0.113.8', '192.168.050.20', '127.0.0.1', '172.32.0.1']) {
  assert.strictEqual(ctx.JF.bridgeAddress('http://' + host + ':18099/v1/' + cap), '');
}
assert.strictEqual(ctx.JF.bridgeAddress('http://192.168.50.20:18099/v1/' + cap + '?token=demo'), '');

ctx.JF.api = {query:obj=>'?'+Object.keys(obj).filter(k=>obj[k]!==null&&obj[k]!==undefined&&obj[k]!=='')
  .map(k=>encodeURIComponent(k)+'='+encodeURIComponent(obj[k])).join('&')};
const item = {};
function source(container, video, audio, defaultAudio) {
  return {Container: container, DefaultAudioStreamIndex: defaultAudio, MediaStreams: [
    Object.assign({Type:'Video', Index:0, Codec:'h264', Width:1920, Height:1080, BitDepth:8, VideoRange:'SDR'},video),
    Object.assign({Type:'Audio', Index:1, Codec:'aac', Profile:'LC', Channels:2},audio)]};
}
let s = source('mp4',{}, {},1);
assert.strictEqual(decide(item,s,null,false).direct,true,'1080p H.264/AAC is direct');
assert.strictEqual(decide(item,s,null,true).direct,false,'user can force Mac transcode');
const dual = source('mp4', {}, {}, 2);
dual.MediaStreams.push({Type:'Audio', Index:2, Codec:'aac', Channels:2});
assert.strictEqual(ctx.JF.audioNeedsRemux(dual, 2), false, 'declared default can use the original MP4');
assert.strictEqual(ctx.JF.audioNeedsRemux(dual, 1), true, 'alternate audio must be selected before reaching the decoder');
assert.strictEqual(ctx.JF.audioNeedsRemux(dual, null), false, 'auto keeps the default');
assert.strictEqual(decide(item,source('mp4',{Width:3840,Height:2160},{},1),null,false).direct,false,'4K needs transcode');
assert.strictEqual(decide(item,source('mp4',{Codec:'hevc',BitDepth:10},{Codec:'eac3',Channels:6},1),null,false).direct,false,'HEVC / Dolby audio');
assert.strictEqual(decide(item,source('mp4',{ColorTransfer:'smpte2084'},{},1),null,false).direct,false,'HDR must not direct play');
assert.strictEqual(decide(item,source('mp4',{ColorTransfer:'pq'},{},1),null,false).direct,false,'PQ must not direct play');
const silent = {Id:'silent', Container:'mp4', MediaStreams:[s.MediaStreams[0]]};
assert.strictEqual(decide(item,silent,null,false).direct,true,'compatible MP4 can direct play without an audio stream');
const cachedVideoProbe = ctx.JF.cachedVideoProbe;
ctx.JF.cachedVideoProbe = () => ({video:{codec:'hevc'},hdrKind:'dolby-vision'});
assert.strictEqual(decide(item,s,null,false).direct,false,'actual probe overrides optimistic server metadata');
ctx.JF.cachedVideoProbe = cachedVideoProbe;
assert.strictEqual(decide(item,source('mkv',{}, {},1),null,false).direct,false,'unsupported container');
assert.strictEqual(decide(item,source('mp4',{}, {Codec:'eac3'},1),null,false).direct,false,'Dolby audio');
let av3 = {Container:'mp4',DefaultAudioStreamIndex:0,MediaStreams:[
  {Type:'Audio',Index:0,CodecTag:'av3a',Channels:6},
  {Type:'Video',Index:2,Codec:'hevc',Width:3840,Height:1608,BitDepth:10},
  {Type:'Audio',Index:3,Codec:'aac',Channels:2}]};
assert.strictEqual(decide(item,av3,null,false).audioIndex,3,'use decodable fallback for Audio Vivid');
const miniUrl = ctx.JF.miniVideoUrl({Id:'movie1'}, {Id:'source1'}, 1, 0);
assert(miniUrl.indexOf('format=mp4') >= 0, 'release uses the existing Mini transcode format');
console.log('PASS: direct vs forced transcode, 4K/HDR/Dolby and audio selection');
