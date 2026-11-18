const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const base = path.join(__dirname, '../app/source');
const kinds = {};
const storage = {'jf.miniBridge':'http://192.168.50.20:18099/v1/PublicFixtureCapability0123456789'};
const logs = [];
const sandbox = {
  window:{JF:{}},
  localStorage:{getItem:k=>storage[k] || '', setItem:(k,v)=>{storage[k]=String(v);}},
  enyo:{kind:x=>{kinds[x.name]=x;}, mixin:Object.assign}, console, setTimeout, clearTimeout, setInterval, clearInterval
};
vm.runInNewContext(fs.readFileSync(path.join(base, 'Compatibility.js'), 'utf8'), sandbox);
vm.runInNewContext(fs.readFileSync(path.join(base, 'App.js'), 'utf8'), sandbox);
vm.runInNewContext(fs.readFileSync(path.join(base, 'PlayerView.js'), 'utf8'), sandbox);
vm.runInNewContext(fs.readFileSync(path.join(base, 'DetailView.js'), 'utf8'), sandbox);
const JF = sandbox.JF;
JF.miniWarmEnabled = true;
JF.log = text => logs.push(text);
const good = {Id:'movie1', MediaType:'Video', MediaSources:[{Id:'source1', Container:'mp4', DefaultAudioStreamIndex:1,
  MediaStreams:[{Type:'Video', Index:0, Codec:'h264', Width:1920, Height:1080, BitDepth:8, VideoRange:'SDR'},
    {Type:'Audio', Index:1, Codec:'aac', Channels:2, Profile:'LC'}]}]};
const hevc = JSON.parse(JSON.stringify(good));
hevc.MediaSources[0].MediaStreams[0].Codec = 'hevc';
const multi = {Id:'movie-multi', MediaType:'Video', MediaSources:[
  {Id:'source-4k', Container:'mkv', MediaStreams:[
    {Type:'Video', Index:0, Codec:'hevc', Width:3840, Height:2160, VideoRangeType:'HDR10'},
    {Type:'Audio', Index:1, Codec:'eac3', Channels:6, IsDefault:true}
  ]},
  {Id:'source-1080', Container:'mp4', DefaultAudioStreamIndex:1, MediaStreams:[
    {Type:'Video', Index:0, Codec:'h264', Width:1920, Height:1080, BitDepth:8, VideoRange:'SDR'},
    {Type:'Audio', Index:1, Codec:'aac', Channels:2, Profile:'LC'}
  ]}
]};
JF.api = {
  baseUrl:'http://emby.invalid', token:'fake-token',
  item:(id, cb)=>cb(true, good),
  query:obj=>'?'+Object.keys(obj).filter(k=>obj[k]!==null&&obj[k]!==undefined&&obj[k]!=='')
    .map(k=>encodeURIComponent(k)+'='+encodeURIComponent(obj[k])).join('&')
};
let relayUrls = [];
let warmUrls = [];
JF.prepareMiniVideo = (url, cb) => {
  warmUrls.push(url);
  cb(url.replace(/\/stream\/.*$/, '/ready/' + String(warmUrls.length).padStart(32, '0')));
  return () => {};
};
JF.relay = {
  needed:url=>/^https?:/i.test(url) && !/^http:\/\/127\.0\.0\.1(?::|\/)/i.test(url),
  open:(url, cb)=>{ relayUrls.push(url); cb('http://127.0.0.1:9999/s/abcd'); }
};
JF.miniProbeConfigured = ()=>true;
JF.cachedVideoProbe = ()=>null;
JF.probeVideo = (item, source, cb)=>cb(true, {
  mediaSourceId:source.Id,
  video:{codec:'hevc', width:1920, height:1080},
  hdrKind:'sdr', miniSupported:true
});
const App = kinds['JF.App'];
const Player = kinds['JF.PlayerView'];
const Detail = kinds['JF.DetailView'];
function appFor(item) {
  let note = '', launched = [], embedded = [];
  const app = {
    $:{
      nowPlaying:{stopAll(){}, playTracks(){}},
      detail:{$:{note:{setContent:v=>{note=v;}}}},
      systemVideoSvc:{call:v=>launched.push(v)},
      player:{playItem:(...args)=>embedded.push(args)},
      pane:{selectViewByName(){} }
    },
    stack:[], tooSoon:()=>false, showMusicBar(){},
    cancelVideoOpen:App.cancelVideoOpen,
    openSystemVideo:App.openSystemVideo, openEmbeddedVideo:App.openEmbeddedVideo,
    probeAndOpenVideo:App.probeAndOpenVideo
  };
  JF.api.item = (id, cb)=>cb(true, item);
  return {app, getNote:()=>note, launched, embedded};
}

// Preserve the upstream in-app player as the default.
delete storage['jf.videoPlayer']; delete storage['jf.videoMode'];
assert.deepStrictEqual(JSON.parse(JSON.stringify(JF.playbackSettings())),
  {player:'embedded', mode:'auto', forceMac:false}, 'defaults are in-app plus automatic');
const savedDialog = {closed:false, close(){this.closed=true;}};
Detail.savePlaySettings.call({$:{
  playPlayer:{getValue:()=> 'embedded'}, playMode:{getValue:()=> 'mini'}, playDialog:savedDialog
}});
assert.strictEqual(savedDialog.closed, true, 'settings dialog closes after saving');
assert.deepStrictEqual(JSON.parse(JSON.stringify(JF.playbackSettings())),
  {player:'embedded', mode:'mini', forceMac:true}, 'saved choices are restored independently');
delete storage['jf.videoPlayer']; delete storage['jf.videoMode'];
let state = appFor(good);
relayUrls = [];
App.playItem.call(state.app, null, good, 300000000, {player:'system', mode:'auto'});
assert(relayUrls[0].startsWith('http://emby.invalid/Videos/'), 'system/auto directly plays compatible H.264/AAC');
assert.strictEqual(state.launched[0].id, 'com.palm.app.videoplayer');
assert.strictEqual(state.launched[0].params.target, 'http://127.0.0.1:9999/s/abcd/video.mp4');
assert.strictEqual(state.launched[0].params.initialPos, 30);
const directLaunch = state.launched[0];

// Each player has the same automatic/forced decision rather than a separate policy.
state = appFor(good); relayUrls = []; warmUrls = [];
App.playItem.call(state.app, null, good, 300000000, {player:'system', mode:'mini'});
assert(warmUrls[0].startsWith(storage['jf.miniBridge'] + '/stream/movie1?'), 'system/mini forces bridge');
assert(warmUrls[0].includes('startSeconds=30'), 'bridge receives the requested start time');
assert(warmUrls[0].includes('format=mkv'), 'Mini route requests MKV output');
assert(relayUrls[0].startsWith(storage['jf.miniBridge'] + '/ready/'), 'only the prepared stream is relayed');
assert.strictEqual(state.launched[0].params.target, 'http://127.0.0.1:9999/s/abcd/video.mp4',
  'opaque MP4 alias avoids the installed system player Ogg workaround for MKV suffixes');
assert.strictEqual(state.launched[0].params.initialPos, 0, 'bridge performs the seek');
const miniLaunch = state.launched[0];

state = appFor(good); relayUrls = [];
App.playItem.call(state.app, null, good, 0, {player:'embedded', mode:'auto'});
assert.strictEqual(state.launched.length, 0, 'embedded/auto does not launch the system player');
assert.strictEqual(state.embedded.length, 1, 'embedded/auto opens the in-app player');
assert.strictEqual(state.embedded[0][2].forceMac, false, 'embedded/auto keeps automatic routing');

state = appFor(good); relayUrls = [];
App.playItem.call(state.app, null, good, 0, {player:'embedded', mode:'mini'});
assert.strictEqual(state.embedded.length, 1, 'embedded/mini opens the in-app player');
assert.strictEqual(state.embedded[0][2].forceMac, true, 'embedded/mini forces the same Mini route');

state = appFor(hevc); relayUrls = []; warmUrls = [];
App.playItem.call(state.app, null, hevc, 0, {player:'system', mode:'auto'});
assert(warmUrls[0].startsWith(storage['jf.miniBridge'] + '/stream/movie1?'), 'automatic HEVC falls back to Mini');

// A selected source must survive the detail refresh. The compatible 1080p
// source stays direct, while the 4K source keeps its own Mini decision.
state = appFor(multi); relayUrls = [];
App.playItem.call(state.app, null, multi, 0, {player:'system', mode:'auto'}, 'source-1080');
assert(relayUrls[0].startsWith('http://emby.invalid/Videos/movie-multi/'), 'selected 1080p source can direct play');
assert(relayUrls[0].includes('mediaSourceId=source-1080'), 'system player route carries selected source id');
assert.strictEqual(state.launched.length, 1);

state = appFor(multi); relayUrls = []; warmUrls = [];
App.playItem.call(state.app, null, multi, 300000000, {player:'system', mode:'mini'}, 'source-1080');
assert(warmUrls[0].startsWith(storage['jf.miniBridge'] + '/stream/movie-multi?'), 'forced Mini keeps selected source');
assert(warmUrls[0].includes('mediaSourceId=source-1080'), 'Mini request carries selected source id');
assert(warmUrls[0].includes('startSeconds=30'), 'selected source Resume keeps its start position');

state = appFor(multi); relayUrls = [];
App.playItem.call(state.app, null, multi, 0, {player:'embedded', mode:'auto'}, 'source-4k');
assert.strictEqual(state.embedded.length, 1, 'embedded player receives selected source');
assert.strictEqual(state.embedded[0][2].source.Id, 'source-4k');

state = appFor(multi); relayUrls = [];
App.playItem.call(state.app, null, multi, 0, {player:'system', mode:'auto'}, 'missing-source');
assert(state.getNote().indexOf('Choose another version') >= 0, 'missing source asks the user to reselect');
assert.strictEqual(relayUrls.length, 0, 'missing source does not silently fall back');
assert.strictEqual(state.launched.length, 0, 'missing source does not launch a player');

// An unconfigured bridge must preserve the selected Jellyfin source and
// the upstream PlaybackInfo route, including server-converted video.
const configured = JF.miniProbeConfigured;
JF.miniProbeConfigured = () => false;
state = appFor(multi); relayUrls = [];
App.playItem.call(state.app, null, multi, 10, {player:'embedded', mode:'auto'}, 'source-4k');
assert.strictEqual(state.embedded.length, 1);
assert.strictEqual(state.embedded[0][0].MediaSources.length, 1);
assert.strictEqual(state.embedded[0][0].MediaSources[0].Id, 'source-4k');
assert.strictEqual(state.embedded[0][2], null, 'no bridge implies the upstream PlaybackInfo path');
assert.strictEqual(relayUrls.length, 0);
JF.miniProbeConfigured = configured;

// A downloaded film stays local even if the persisted setting names the system player.
JF.downloads = {localFile:id=>id === good.Id ? '/media/internal/movie.mp4' : null};
state = appFor(good);
App.playItem.call(state.app, null, good, 0, {player:'system', mode:'auto'});
assert.strictEqual(state.embedded.length, 1, 'downloaded video remains in the established local player path');
JF.downloads = null;

// The in-app Mini stream is rebuilt for each requested seek and receives only
// the relay's local URL. It must not use the video element's random-access seek.
let localUrls = [];
relayUrls = [];
warmUrls = [];
const planned = {
  item:good, routePlan:{source:good.MediaSources[0], forceMac:true}, audioIndex:1,
  request:{}, playing:true, setStatus(){}, playUrl:url=>localUrls.push(url)
};
Player.startPlannedStream.call(planned, 900000000, planned.request);
assert(warmUrls[0].includes('startSeconds=90'), 'first Mini route starts at the requested tick');
assert(warmUrls[0].includes('audioStreamIndex=1'), 'Mini route carries the selected audio track');
assert(localUrls[0].endsWith('/video.mp4'), 'the in-app player uses the tested opaque alias');
assert.strictEqual(planned.direct, false, 'Mini stream is not treated as a seekable local file');
assert.strictEqual(planned.pendingSeek, null, 'Mini stream does not set a local seek position');
planned.request = {};
Player.startPlannedStream.call(planned, 1200000000, planned.request);
assert(warmUrls[1].includes('startSeconds=120'), 'seek creates a new Mini stream at the new tick');
assert.notStrictEqual(relayUrls[0], relayUrls[1], 'seek does not reuse the old live URL');
let restartAt = null, videoCurrentTime = null;
Player.seekTo.call({
  $:{video:{hasNode:()=>({set currentTime(v){videoCurrentTime=v;}})}}, playing:true, direct:false,
  durationTicks:()=>0, seekLimit:Player.seekLimit, tellServer(){}, startStream:t=>{restartAt=t;}
}, 1500000000);
assert.strictEqual(restartAt, 1500000000, 'non-direct seek restarts a stream');
assert.strictEqual(videoCurrentTime, null, 'non-direct seek does not fake local random access');
assert.strictEqual(Player.positionTicks.call({
  info:{method:'MacMini'}, hasPlayed:true, startTicks:1200000000,
  $:{video:{hasNode:()=>({currentTime:4.25})}}
}), 1242500000, 'playhead follows decoded media time plus the requested offset');

// A stale warm operation may finish just as the user backs out. Do not open
// the system application with that URL.
const completedPrepare = JF.prepareMiniVideo;
let completeWarm, warmCancelled = false;
JF.prepareMiniVideo = (url, cb) => {
  completeWarm = cb;
  return () => {warmCancelled = true;};
};
state = appFor(hevc); relayUrls = [];
App.playItem.call(state.app, null, hevc, 0, {player:'system', mode:'auto'});
assert.strictEqual(state.launched.length, 0, 'the system player waits for the real warm result');
state.app.cancelVideoOpen();
assert(warmCancelled, 'leaving cancels the warm request');
completeWarm(storage['jf.miniBridge'] + '/ready/' + 'f'.repeat(32));
assert.strictEqual(state.launched.length, 0, 'a late result cannot launch a closed player');
JF.prepareMiniVideo = completedPrepare;

// Companion apps can only hand in an opaque loopback relay; URLs cannot carry
// account credentials or a remote bridge capability in a query or fragment.
const localUrl = 'http://127.0.0.1:16784/s/a1b2c3/video.mp4';
assert.strictEqual(JF.localVideoUrl(localUrl), localUrl, 'strict loopback relay is accepted');
const localMkvUrl = 'http://127.0.0.1:16784/s/a1b2c3/video.mkv';
assert.strictEqual(JF.localVideoUrl(localMkvUrl), localMkvUrl, 'MKV loopback relay is accepted');
assert.strictEqual(JF.localVideoUrl('http://192.168.50.30:16784/s/a1b2c3/video.mp4'), '', 'non-loopback URL is rejected');
assert.strictEqual(JF.localVideoUrl(localUrl + '?token=fake-token'), '', 'query values are rejected');
assert.strictEqual(JF.localVideoUrl(localUrl + '#fragment'), '', 'fragments are rejected');
let invalidStatus = '';
assert.strictEqual(Player.playLocalUrl.call({setStatus:v=>{invalidStatus=v;}}, 'http://127.0.0.1:16784/s/nope/video.mp4'), false,
  'player validates a second time before touching UI state');
assert(invalidStatus, 'invalid local playback reports a generic message without the URL');
let launchedLocalUrls = [];
App.testLaunch.call({openLocalVideo:url=>launchedLocalUrls.push(url)}, {playLocalUrl:localUrl});
assert.deepStrictEqual(launchedLocalUrls, [localUrl], 'launch parameter reaches the local-player entry point');
sandbox.enyo.windowParams = {playLocalUrl:localUrl};
App.windowParamsChanged.call({openLocalVideo:url=>launchedLocalUrls.push(url)});
assert.deepStrictEqual(launchedLocalUrls, [localUrl, localUrl], 'running app accepts the same local-player parameter');
let localPlayed = [], apiCalls = 0;
state = appFor(good);
state.app.$.player.playLocalUrl = url=>localPlayed.push(url);
state.app.openLocalVideo = App.openLocalVideo;
const itemBeforeLocal = JF.api.item;
JF.api.item = ()=>{apiCalls++;};
assert.strictEqual(App.openLocalVideo.call(state.app, localUrl), true, 'valid local relay opens the in-app player');
assert.deepStrictEqual(localPlayed, [localUrl], 'only the approved local URL reaches the player');
assert.strictEqual(apiCalls, 0, 'local launch does not fetch an Emby item');
JF.api.item = itemBeforeLocal;
let reports = 0, stopped = 0, localStart = '';
const report = JF.api.report, stopEncoding = JF.api.stopEncoding;
JF.api.report = ()=>{reports++;}; JF.api.stopEncoding = ()=>{stopped++;};
relayUrls = [];
const localStream = {localUrl, request:{}, playing:true, setStatus(){}, playUrl:url=>{localStart=url;}};
Player.startLocalStream.call(localStream, 0, localStream.request);
Player.tellServer.call({item:null, info:{localBridge:true}, positionTicks:()=>0}, '/Sessions/Playing');
Player.endEncoding.call({info:{localBridge:true}, direct:false});
assert.strictEqual(localStart, localUrl, 'local in-app stream bypasses the relay and receives no rewritten URL');
assert.strictEqual(relayUrls.length, 0, 'local in-app stream does not invoke the Emby relay');
assert.strictEqual(reports, 0, 'local in-app stream does not report Emby progress');
assert.strictEqual(stopped, 0, 'local in-app stream does not stop an Emby transcode');
JF.api.report = report; JF.api.stopEncoding = stopEncoding;

const exposed = JSON.stringify([directLaunch, miniLaunch]) + localUrls.join(' ') + logs.join(' ');
assert(!exposed.includes('fake-token'), 'account token never reaches launch URLs or logs');
assert(!exposed.includes('test-capability'), 'Mini capability never reaches launch URLs or logs');
console.log('PASS: player choices, Mini routing, seek regeneration, local downloads and secret boundary');
