const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const base = path.join(__dirname, '../app/source');
const storage = {'jf.miniBridge':'http://192.168.50.20:18099/v1/PublicFixtureCapability0123456789'};
const requests = [];
const timers = [];
const kinds = {};

function fakeSetTimeout(fn, ms) {
  timers.push({fn:fn, ms:ms, cancelled:false});
  return timers.length;
}
function fakeClearTimeout(id) {
  if (timers[id - 1]) timers[id - 1].cancelled = true;
}
function FakeXHR() {
  this.headers = {};
  requests.push(this);
}
FakeXHR.prototype.open = function(method, url, async) {
  this.method = method;
  this.url = url;
  this.async = async;
};
FakeXHR.prototype.setRequestHeader = function(name, value) {
  this.headers[name] = value;
};
FakeXHR.prototype.send = function() { this.sent = true; };
FakeXHR.prototype.abort = function() {
  this.aborted = true;
  if (this.onabort) this.onabort();
};
function respond(request, status, body) {
  request.status = status;
  request.responseText = JSON.stringify(body);
  request.readyState = 4;
  request.onreadystatechange();
}

const sandbox = {
  window:{JF:{}},
  localStorage:{getItem:key=>storage[key] || '', setItem:(key, value)=>{storage[key]=String(value);}},
  XMLHttpRequest:FakeXHR,
  setTimeout:fakeSetTimeout,
  clearTimeout:fakeClearTimeout,
  enyo:{kind:def=>{kinds[def.name]=def;}},
  console:{log(){}, warn(){}, error(){}}
};
vm.runInNewContext(fs.readFileSync(path.join(base, 'Compatibility.js'), 'utf8'), sandbox);
const JF = sandbox.JF;
JF.api = {get(){ throw new Error('probe must not use the Emby API helper'); }};

const item = {Id:'item/one', MediaType:'Video'};
const source = {Id:'source two', Container:'mkv'};
const result = [];
JF.probeVideo(item, source, (ok, info)=>result.push({ok:ok, info:info}));
JF.probeVideo(item, source, (ok, info)=>result.push({ok:ok, info:info}));
assert.strictEqual(requests.length, 1, 'same probe is deduplicated while pending');
assert.strictEqual(requests[0].method, 'GET');
assert(requests[0].url.indexOf('/probe/item%2Fone?mediaSourceId=source%20two') >= 0,
  'probe uses the selected item and exact media source');
assert.deepStrictEqual(requests[0].headers, {Accept:'application/json'},
  'probe does not send an Emby token or other secret header');
assert.strictEqual(timers[timers.length - 1].ms, 20000, 'probe timeout leaves room for a cold Mini probe');
respond(requests[0], 200, {
  returnValue:true, mediaSourceId:'source two',
  video:{codec:'hevc', profile:'Main 10', pixFmt:'yuv420p10le', bitDepth:10,
    width:1920, height:800, colorTransfer:'smpte2084', colorPrimaries:'bt2020',
    colorSpace:'bt2020nc', colorRange:'tv', dolbyVisionProfile:5},
  audio:{codec:'aac', channels:2}, hdrKind:'dolby-vision', miniSupported:false,
  reason:'unsupported DV profile'
});
assert.strictEqual(result.length, 2, 'all deduplicated callers receive the result');
assert.strictEqual(result[0].ok, true);
assert.strictEqual(result[0].info.mediaSourceId, source.Id);
assert.strictEqual(result[0].info.video.dolbyVisionProfile, 5);
assert.strictEqual(result[0].info.miniSupported, false);
const requestCount = requests.length;
let cached = null;
JF.probeVideo(item, source, (ok, info)=>{cached = {ok:ok, info:info};});
assert.strictEqual(requests.length, requestCount, 'successful probes are cached');
assert.strictEqual(cached.ok, true);

storage['jf.miniBridge'] = '';
let unconfigured = null;
JF.probeVideo({Id:'no-bridge'}, {Id:'s'}, (ok)=>{unconfigured = ok;});
assert.strictEqual(unconfigured, false, 'unconfigured Mini fails without making a request');
assert.strictEqual(requests.length, requestCount);
storage['jf.miniBridge'] = 'http://192.168.50.20:18099/v1/PublicFixtureCapability0123456789';

vm.runInNewContext(fs.readFileSync(path.join(base, 'DetailView.js'), 'utf8'), sandbox);
vm.runInNewContext(fs.readFileSync(path.join(base, 'App.js'), 'utf8'), sandbox);
const Detail = kinds['JF.DetailView'];
const App = kinds['JF.App'];

function node() {
  return {content:'', showing:false, disabled:false,
    setContent(value){this.content=value;}, setShowing(value){this.showing=value;},
    setDisabled(value){this.disabled=!!value;}};
}
function viewFor(movie, sourceId) {
  return {
    item:movie, selectedSourceId:sourceId, probeSerial:0,
    streamFor:Detail.streamFor, sourceById:Detail.sourceById,
    mediaInfoFor:Detail.mediaInfoFor, bitrateText:Detail.bitrateText,
    probeHdrText:Detail.probeHdrText,
    setProbeNote:Detail.setProbeNote, setPlaybackDisabled:Detail.setPlaybackDisabled,
    shouldDisableForProbe:Detail.shouldDisableForProbe,
    probeSelectedSource:Detail.probeSelectedSource,
    $:{probeNote:node(), mediaInfo:node(), videoInfo:node(), audioInfo:node(),
      play:node(), resume:node()}
  };
}

const sourceOne = {Id:'source-one', Container:'mp4', MediaStreams:[
  {Type:'Video', Codec:'h264', Width:640, Height:360, VideoRange:'SDR'},
  {Type:'Audio', Codec:'aac', Channels:2}
]};
const sourceTwo = {Id:'source-two', Container:'mkv', MediaStreams:[
  {Type:'Video', Codec:'hevc', Width:1280, Height:720, VideoRange:'SDR'},
  {Type:'Audio', Codec:'aac', Channels:2}
]};
const movie = {Id:'movie', MediaType:'Video', MediaSources:[sourceOne, sourceTwo]};
const oldProbe = JF.probeVideo;
const oldCached = JF.cachedVideoProbe;
JF.cachedVideoProbe = ()=>null;
const pending = [];
JF.probeVideo = (movieArg, sourceArg, callback)=>pending.push({movie:movieArg, source:sourceArg, callback:callback});
const staleView = viewFor(movie, sourceOne.Id);
staleView.probeSerial = 1;
Detail.probeSelectedSource.call(staleView, movie, sourceOne, 1);
staleView.selectedSourceId = sourceTwo.Id;
staleView.probeSerial = 2;
Detail.probeSelectedSource.call(staleView, movie, sourceTwo, 2);
staleView.$.videoInfo.content = 'keep-current-source';
pending[0].callback(true, {mediaSourceId:sourceOne.Id,
  video:{codec:'hevc', width:1920, height:800, bitDepth:10, dolbyVisionProfile:5},
  audio:{codec:'aac', channels:2}, hdrKind:'dolby-vision', miniSupported:false});
assert.strictEqual(staleView.$.videoInfo.content, 'keep-current-source',
  'a stale source probe cannot overwrite the current source UI');
assert.strictEqual(staleView.$.play.disabled, false,
  'a stale unsupported probe cannot disable the current source actions');
pending[1].callback(true, {mediaSourceId:sourceTwo.Id,
  video:{codec:'hevc', width:1280, height:720, bitDepth:8},
  audio:{codec:'aac', channels:2}, hdrKind:'sdr', miniSupported:true});
assert(staleView.$.videoInfo.content.indexOf('HEVC') >= 0,
  'the current source probe updates the displayed media facts');
assert.strictEqual(staleView.$.resume.disabled, false,
  'a supported current source leaves Resume enabled');

const dvView = viewFor(movie, sourceTwo.Id);
dvView.probeSerial = 3;
JF.probeVideo = (movieArg, sourceArg, callback)=>callback(true, {
  mediaSourceId:sourceArg.Id,
  video:{codec:'hevc', width:1920, height:800, bitDepth:10, dolbyVisionProfile:5},
  audio:{codec:'aac', channels:2}, hdrKind:'dolby-vision', miniSupported:false
});
Detail.probeSelectedSource.call(dvView, movie, sourceTwo, 3);
assert(dvView.$.videoInfo.content.indexOf('Dolby Vision Profile 5') >= 0,
  'actual Dolby Vision metadata replaces the server SDR label');
assert.strictEqual(dvView.$.videoInfo.content.indexOf('Range: SDR') >= 0, false);
assert(dvView.$.probeNote.content.indexOf('cannot convert') >= 0,
  'unsupported Dolby Vision Profile 5 is shown as a safe warning');
assert.strictEqual(dvView.$.play.disabled, true, 'unsupported DV5 disables Play');
assert.strictEqual(dvView.$.resume.disabled, true, 'unsupported DV5 disables Resume');

// A direct SDR source remains usable even when a stale/negative Mini result is
// returned; changing the selector resets the buttons before the callback.
JF.probeVideo = (movieArg, sourceArg, callback)=>callback(true, {
  mediaSourceId:sourceArg.Id,
  video:{codec:'h264', width:640, height:360, bitDepth:8},
  audio:{codec:'aac', channels:2}, hdrKind:'sdr', miniSupported:false
});
Detail.sourceChanged.call(dvView, {getValue:()=>sourceOne.Id});
assert.strictEqual(dvView.$.play.disabled, false, 'switching to direct SDR re-enables Play');
assert.strictEqual(dvView.$.resume.disabled, false, 'switching to direct SDR re-enables Resume');

// Failed or unconfigured probes must not turn the page into a dead end.
JF.probeVideo = (movieArg, sourceArg, callback)=>callback(false, null);
dvView.selectedSourceId = sourceTwo.Id;
dvView.probeSerial = 5;
dvView.$.play.disabled = true;
dvView.$.resume.disabled = true;
Detail.probeSelectedSource.call(dvView, movie, sourceTwo, 5);
assert.strictEqual(dvView.$.play.disabled, false, 'probe failure leaves Play enabled');
assert.strictEqual(dvView.$.resume.disabled, false, 'probe failure leaves Resume enabled');
JF.miniProbeConfigured = ()=>false;
dvView.probeSerial = 6;
dvView.$.play.disabled = true;
dvView.$.resume.disabled = true;
Detail.probeSelectedSource.call(dvView, movie, sourceTwo, 6);
assert.strictEqual(dvView.$.play.disabled, false, 'unconfigured Mini leaves Play enabled');
assert.strictEqual(dvView.$.resume.disabled, false, 'unconfigured Mini leaves Resume enabled');

let opened = 0;
let note = '';
const app = {
  $:{nowPlaying:{stopAll(){}}, detail:{$:{note:{setContent:value=>{note=value;}}}},
    pane:{selectViewByName(){}}, player:{playItem(){}}},
  stack:[], tooSoon:()=>false, showMusicBar(){},
  cancelVideoOpen:App.cancelVideoOpen,
  openEmbeddedVideo(){opened++;}, openSystemVideo(){opened++;},
  probeAndOpenVideo:App.probeAndOpenVideo
};
JF.api.item = (id, callback)=>callback(true, movie);
JF.probeVideo = (movieArg, sourceArg, callback)=>callback(true, {
  mediaSourceId:sourceArg.Id,
  video:{codec:'hevc', width:1920, height:800, dolbyVisionProfile:5},
  hdrKind:'dolby-vision', miniSupported:false
});
JF.miniProbeConfigured = ()=>true;
App.playItem.call(app, null, movie, 0, {player:'system', mode:'auto'}, sourceTwo.Id);
assert.strictEqual(opened, 0, 'unsupported DV5 is refused before opening a player');
assert(note.indexOf('Choose another version') >= 0, 'DV5 refusal explains how to continue');

JF.probeVideo = (movieArg, sourceArg, callback)=>callback(true, {
  mediaSourceId:sourceArg.Id,
  video:{codec:'hevc', width:1920, height:800, bitDepth:10},
  hdrKind:'hdr10', miniSupported:true
});
note = '';
App.playItem.call(app, null, movie, 0, {player:'system', mode:'auto'}, sourceTwo.Id);
assert.strictEqual(opened, 1, 'a verified HDR10 source is allowed to open the selected player');

JF.probeVideo = (movieArg, sourceArg, callback)=>callback(false, null);
note = '';
App.playItem.call(app, null, movie, 0, {player:'system', mode:'auto'}, sourceTwo.Id);
assert.strictEqual(opened, 1, 'probe failure does not open a potentially wrong-colour player');
assert(note.indexOf('try again') >= 0, 'probe failure gives an explicit retry message');

JF.probeVideo = oldProbe;
JF.cachedVideoProbe = oldCached;
console.log('PASS: protected Mini probe, exact-source UI, stale callbacks and DV5 playback gate');
