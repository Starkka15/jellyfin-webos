const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const base = path.join(__dirname, '../app/source');
let Detail = null;
const sandbox = {window:{JF:{}}, localStorage:{getItem:()=>''}, enyo:{kind:x=>{Detail=x;}}};
vm.runInNewContext(fs.readFileSync(path.join(base, 'Compatibility.js'), 'utf8'), sandbox);
vm.runInNewContext(fs.readFileSync(path.join(base, 'DetailView.js'), 'utf8'), sandbox);
const JF = sandbox.JF;
const view = {streamFor:Detail.streamFor, bitrateText:Detail.bitrateText,
  sourceFor:Detail.sourceFor, sourceById:Detail.sourceById};
function media(item, source) {
  return Detail.mediaInfoFor.call(view, item, source);
}

const h264 = {Id:'h264', MediaType:'Video', MediaSources:[{
  Id:'h264-source', Container:'mp4', Bitrate:4800000, DefaultAudioStreamIndex:2, MediaStreams:[
    {Type:'Video', Index:0, Codec:'h264', Width:1920, Height:1080, VideoRange:'SDR'},
    {Type:'Audio', Index:1, Codec:'mp3', Channels:2},
    {Type:'Audio', Index:2, Codec:'aac', Channels:2}
  ]
}]};
let info = media(h264);
assert.strictEqual(info.video, 'Video: H264 · 1920×1080 · MP4 · Range: SDR · 4.8 Mb/s');
assert.strictEqual(info.audio, 'Audio: AAC · 2 ch', 'source default audio is displayed');

const hevc = {Id:'hevc', MediaType:'Video', MediaSources:[{
  Id:'hevc-source', Container:'mkv', Bitrate:24000000, MediaStreams:[
    {Type:'Video', Index:0, Codec:'hevc', Width:3840, Height:2160, VideoRangeType:'HDR10'},
    {Type:'Audio', Index:1, Codec:'eac3', Channels:6, IsDefault:true}
  ]
}]};
info = media(hevc);
assert.strictEqual(info.video, 'Video: HEVC · 3840×2160 · MKV · Range: HDR10 · 24 Mb/s');
assert.strictEqual(info.audio, 'Audio: EAC3 · 6 ch');

const multi = {Id:'multi', MediaType:'Video', MediaStreams:[
  {Type:'Audio', Index:9, Codec:'aac', Channels:2}
], MediaSources:[
  {Id:'four-k', Container:'mkv', MediaStreams:[
    {Type:'Video', Index:0, Codec:'hevc', Width:3840, Height:2160, VideoRangeType:'HDR10'},
    {Type:'Audio', Index:1, Codec:'eac3', Channels:6, IsDefault:true}
  ]},
  {Id:'full-hd', Container:'mp4', MediaStreams:[
    {Type:'Video', Index:0, Codec:'h264', Width:1920, Height:1080}
  ]}
]};
assert.strictEqual(Detail.sourceLabel.call(view, multi, multi.MediaSources[0]), 'HEVC · 3840×2160 · MKV');
assert.strictEqual(Detail.sourceLabel.call(view, multi, multi.MediaSources[1]), 'H264 · 1920×1080 · MP4');
info = media(multi, multi.MediaSources[1]);
assert.strictEqual(info.video, 'Video: H264 · 1920×1080 · MP4');
assert.strictEqual(info.audio, 'Audio: Unknown codec · Unknown channels',
  'selected source does not borrow audio from item-level or another source');

const selector = {
  selectedSourceId:null, sourceItemId:null, streamFor:Detail.streamFor, sourceById:Detail.sourceById,
  sourceLabel:Detail.sourceLabel, sourceItems:Detail.sourceItems, mediaInfoFor:Detail.mediaInfoFor,
  setPlaybackDisabled:Detail.setPlaybackDisabled, probeSelectedSource:function(){},
  bitrateText:Detail.bitrateText,
  $:{
    sourceRow:{shown:null, setShowing(v){this.shown=v;}},
    sourceSelector:{items:null, value:null, setItems(v){this.items=v;}, setValue(v){this.value=v;}},
    mediaInfo:{shown:null, setShowing(v){this.shown=v;}},
    videoInfo:{value:'', setContent(v){this.value=v;}}, audioInfo:{value:'', setContent(v){this.value=v;}},
    play:{setDisabled(){}}, resume:{setDisabled(){}}
  }
};
let selected = Detail.setSourceOptions.call(selector, multi);
assert.strictEqual(selector.$.sourceRow.shown, true, 'selector is only shown for multiple sources');
assert.strictEqual(selector.$.sourceSelector.items.length, 2);
assert.strictEqual(selected.Id, 'four-k', 'current movie starts at its first source');
selector.item = multi;
Detail.sourceChanged.call(selector, {getValue:()=> 'full-hd'});
assert.strictEqual(selector.selectedSourceId, 'full-hd');
assert.strictEqual(selector.$.audioInfo.value, 'Audio: Unknown codec · Unknown channels');
selected = Detail.setSourceOptions.call(selector, h264);
assert.strictEqual(selector.$.sourceRow.shown, false, 'single-source item hides selector');
assert.strictEqual(selected.Id, 'h264-source', 'selection is not carried into a different movie');

const playRequests = [];
JF.log = ()=>{};
JF.playbackSettings = value => value || {player:'system', mode:'auto'};
const actions = {
  item:{Id:'multi', MediaType:'Video', UserData:{PlaybackPositionTicks:300000000}},
  selectedSourceId:'full-hd',
  doPlay:function() { playRequests.push(Array.from(arguments)); }
};
Detail.playClick.call(actions);
Detail.resumeClick.call(actions);
Detail.forceMacClick.call(actions);
assert.deepStrictEqual(playRequests.map(request=>request[3]), ['full-hd', 'full-hd', 'full-hd'],
  'Play, Resume and Mac mini requests all carry the selected source id');
assert.strictEqual(playRequests[1][1], 300000000, 'Resume retains the stored position');
assert.strictEqual(playRequests[2][2].mode, 'mini', 'Mac mini button still forces Mini mode');

const moreRequests = [];
const moreActions = {
  item:{Id:'multi', MediaType:'Video', UserData:{PlaybackPositionTicks:300000000}},
  selectedSourceId:'full-hd', watchedCaption:'Mark Watched', favoriteCaption:'Add to Favorites',
  downloadCaption:'Download',
  $:{
    more:{},
    menu:{items:null, around:null, setItems(v){this.items=v;}, openAroundControl(v){this.around=v;}}
  },
  doPlay:function() { moreRequests.push(Array.from(arguments)); },
  playClick:Detail.playClick,
  forceMacClick:Detail.forceMacClick
};
Detail.moreClick.call(moreActions);
assert.deepStrictEqual(Array.from(moreActions.$.menu.items, item=>item.value),
  ['start', 'watched', 'download', 'mini', 'favorite'], 'More retains every secondary video action');
assert.strictEqual(moreActions.$.menu.around, moreActions.$.more, 'More menu opens from its compact control');
Detail.menuSelect.call(moreActions, null, {getValue:()=> 'start'});
Detail.menuSelect.call(moreActions, null, {getValue:()=> 'mini'});
assert.deepStrictEqual(moreRequests.map(request=>request[3]), ['full-hd', 'full-hd'],
  'More playback paths retain the selected source id');
assert.strictEqual(moreRequests[1][2].mode, 'mini', 'More exposes the explicit Mini test mode');

const missing = {Id:'missing', MediaType:'Video', MediaSources:[{MediaStreams:[{Type:'Video'}]}]};
info = media(missing);
assert.strictEqual(info.video, 'Video: Unknown codec · Unknown resolution · Unknown container');
assert.strictEqual(info.audio, 'Audio: Unknown codec · Unknown channels');
assert.strictEqual(media({Id:'audio', MediaType:'Audio'}), null, 'non-video items do not show video facts');

const brief = {Id:'h264', MediaType:'Video'};
const shown = [];
const detailView = {
  item:null,
  showItem:function(item) {
    this.item = item;
    shown.push({item:item, info:media(item)});
  }
};
JF.api = {item:(id, callback)=>callback(true, h264)};
Detail.open.call(detailView, brief);
assert.strictEqual(shown.length, 2, 'brief item is shown before the complete item returns');
assert.strictEqual(shown[0].info.video, 'Video: Unknown codec · Unknown resolution · Unknown container');
assert.strictEqual(shown[1].info.video, 'Video: H264 · 1920×1080 · MP4 · Range: SDR · 4.8 Mb/s');
console.log('PASS: media facts, source switching, missing audio and full-item refresh');
