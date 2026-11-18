const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');

const kinds = {};
const logs = [];
const preferences = {};
const JF = {log: text => logs.push(text)};
const sandbox = {
  window: {JF}, JF, console, setTimeout, clearTimeout,
  localStorage: {setItem: (key, value) => {preferences[key] = value;}},
  enyo: {VFlexBox: {}, kind: x => {kinds[x.name] = x;}}
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app/source/PlayerView.js'), 'utf8'), sandbox);
const Player = kinds['JF.PlayerView'];

function state(options) {
  options = options || {};
  const node = Object.prototype.hasOwnProperty.call(options, 'node') ? options.node : {error: null};
  const counters = {keep: [], clock: [], watch: 0, resume: 0, captions: [], playingIcon: [], status: [], showing: [], reports: [], retry: []};
  const player = {
    playing: true, wasShowing: false, paused: false, interrupted: false, byHand: false,
    request: {}, positionTicks: () => 123000000,
    $: {
      video: {hasNode: () => node},
      pauseButton: {
        setCaption: value => counters.captions.push(value),
        addRemoveClass: (name, on) => {if (name === 'jf-symbol-play') counters.playingIcon.push(on);}
      },
      status: {
        setContent: value => counters.status.push(value),
        setShowing: value => counters.showing.push(value)
      }
    },
    keepScreenOn: value => counters.keep.push(value),
    clockRun: value => counters.clock.push(value),
    watchDecoder: () => {counters.watch += 1;},
    resumeAfterInterruption: () => {counters.resume += 1;},
    tellServer: pathName => counters.reports.push(pathName),
    setRetryShowing: value => counters.retry.push(value),
    showRetry: Player.showRetry,
    setPauseButton: Player.setPauseButton,
    setStatus: Player.setStatus
  };
  return {player, counters};
}

let icon = state();
Player.setPauseButton.call(icon.player, true);
Player.setPauseButton.call(icon.player, false);
assert.deepStrictEqual(icon.counters.captions, ['Play', 'Pause']);
assert.deepStrictEqual(icon.counters.playingIcon, [true, false]);

// The first playing event still performs all normal setup.
logs.length = 0;
let view = state();
Player.videoEvent.call(view.player, {type: 'playing'});
assert.deepStrictEqual(logs, ['video playing']);
assert.strictEqual(view.player.wasShowing, true);
assert.deepStrictEqual(view.counters.keep, [true]);
assert.deepStrictEqual(view.counters.clock, [true]);
assert.strictEqual(view.counters.watch, 1);
assert.deepStrictEqual(view.counters.captions, ['Pause']);
assert.deepStrictEqual(view.counters.status, ['']);
assert.deepStrictEqual(view.counters.showing, [false]);
assert.deepStrictEqual(view.counters.retry, [false]);

// Repeated events from the same stream are idempotent, even at high volume.
for (let i = 0; i < 1000; i++) {
  Player.videoEvent.call(view.player, {type: 'playing'});
}
assert.deepStrictEqual(logs, ['video playing'], 'duplicate playing events do not log');
assert.deepStrictEqual(view.counters.keep, [true], 'duplicate playing events do not keep the screen awake again');
assert.deepStrictEqual(view.counters.clock, [true], 'duplicate playing events do not restart the clock');
assert.strictEqual(view.counters.watch, 1, 'duplicate playing events do not start another watchdog');
assert.deepStrictEqual(view.counters.captions, ['Pause']);
assert.deepStrictEqual(view.counters.status, ['']);
assert.deepStrictEqual(view.counters.retry, [false]);

// A real hand pause clears the guard; the next playing event restores state.
logs.length = 0;
view = state();
Player.videoEvent.call(view.player, {type: 'playing'});
view.player.byHand = true;
Player.videoEvent.call(view.player, {type: 'pause'});
Player.videoEvent.call(view.player, {type: 'playing'});
assert.deepStrictEqual(logs, ['video playing', 'video pause', 'video playing']);
assert.strictEqual(view.player.paused, false);
assert.strictEqual(view.player.interrupted, false);
assert.deepStrictEqual(view.counters.keep, [true, false, true]);
assert.deepStrictEqual(view.counters.clock, [true, false, true]);
assert.strictEqual(view.counters.watch, 2);
assert.deepStrictEqual(view.counters.captions, ['Pause', 'Play', 'Pause']);
assert.deepStrictEqual(view.counters.retry, [false, false]);

// A system interruption must still take the recovery path, not the duplicate guard.
logs.length = 0;
view = state();
view.player.wasShowing = true;
view.player.paused = true;
view.player.interrupted = true;
Player.videoEvent.call(view.player, {type: 'playing'});
assert.deepStrictEqual(logs, ['video playing']);
assert.strictEqual(view.counters.resume, 1);
assert.deepStrictEqual(view.counters.keep, []);
assert.deepStrictEqual(view.counters.clock, []);
assert.strictEqual(view.counters.watch, 0);

// The existing inactive/null-node guard remains unchanged.
logs.length = 0;
view = state();
view.player.playing = false;
Player.videoEvent.call(view.player, {type: 'playing'});
assert.deepStrictEqual(logs, []);
assert.deepStrictEqual(view.counters.keep, []);
view = state({node: null});
Player.videoEvent.call(view.player, {type: 'playing'});
assert.deepStrictEqual(logs, []);
assert.deepStrictEqual(view.counters.keep, []);

// A new request/startStream reset of wasShowing allows the next playing event.
view = state();
logs.length = 0;
Player.videoEvent.call(view.player, {type: 'playing'});
view.player.request = {};
view.player.wasShowing = false;
Player.videoEvent.call(view.player, {type: 'playing'});
assert.deepStrictEqual(logs, ['video playing', 'video playing']);
assert.strictEqual(view.counters.watch, 2);

function routePlayer(options) {
  options = options || {};
  const statuses = [];
  const source = options.source || {Id: 'source-1', MediaStreams: [
    {Type: 'Video', Codec: 'h264', Width: 1920, Height: 1080, BitDepth: 8},
    {Type: 'Audio', Index: 2, Codec: 'aac', Channels: 2, IsDefault: true}
  ]};
  const player = {
    item: {Id: 'item-1'}, routePlan: {source}, info: options.info || {method: 'DirectPlay'},
    audioIndex: null, playbackMode: options.mode || 'auto', playing: true, waitingForRoute: false,
    $: {status: {setContent: value => statuses.push(value), setShowing: () => {}}, retryButton: {setShowing: () => {}}},
    codecCaption: Player.codecCaption,
    selectedSourceAudio: Player.selectedSourceAudio,
    sourceCaption: Player.sourceCaption,
    routeCaption: Player.routeCaption,
    canChooseMacMini: Player.canChooseMacMini,
    setStatus: Player.setStatus,
    showControls: () => {player.controlsShown = (player.controlsShown || 0) + 1;},
    restartHere: () => {player.restarts = (player.restarts || 0) + 1;},
    restartControlsTimer: () => {player.timerRestarts = (player.timerRestarts || 0) + 1;},
    setRetryShowing: value => {player.retry = value;}
  };
  return {player, statuses, source};
}

// The route menu describes facts from the selected source. It does not claim a
// hardware decoder, because that is only visible to the native pipeline.
let route = routePlayer();
assert.strictEqual(Player.sourceCaption.call(route.player), 'Source: H.264 · 1920×1080 · 8-bit · AAC stereo');
assert.strictEqual(Player.routeCaption.call(route.player), 'Route: direct');
route.player.info = {method: 'MacMini'};
assert.strictEqual(Player.routeCaption.call(route.player), 'Route: Mac mini conversion');

// Mini conversion is session-only and starts only after the exact selected
// source has passed the existing probe.
JF.miniProbeConfigured = () => true;
let probeCalls = [];
JF.probeVideo = (item, source, callback) => {
  probeCalls.push({item, source});
  callback(true, {mediaSourceId: source.Id, miniSupported: true});
};
route = routePlayer();
Player.selectPlaybackMode.call(route.player, 'mini');
assert.strictEqual(route.player.playbackMode, 'mini');
assert.strictEqual(route.player.restarts, 1);
assert.strictEqual(probeCalls.length, 1);
assert.strictEqual(probeCalls[0].source, route.source);

// A stale reply cannot switch routes after the user has moved on.
let delayedProbe;
JF.probeVideo = (item, source, callback) => { delayedProbe = callback; };
route = routePlayer();
Player.selectPlaybackMode.call(route.player, 'mini');
Player.selectPlaybackMode.call(route.player, 'auto');
assert.strictEqual(route.player.playbackChoice, null, 'returning to Auto cancels the pending Mini check');
delayedProbe(true, {mediaSourceId: route.source.Id, miniSupported: true});
assert.strictEqual(route.player.playbackMode, 'auto');
assert.strictEqual(route.player.restarts, undefined);

// A failed check leaves the existing mode intact and explains the recovery.
JF.probeVideo = (item, source, callback) => callback(true, {mediaSourceId: source.Id, miniSupported: false});
route = routePlayer();
Player.selectPlaybackMode.call(route.player, 'mini');
assert.strictEqual(route.player.playbackMode, 'auto');
assert.strictEqual(route.player.restarts, undefined);
assert.match(route.statuses.at(-1), /bridge cannot convert/);

// Retry is visible recovery for a stalled/error stream and preserves the
// established request path instead of creating a separate player mode.
route = routePlayer();
Player.retryClick.call(route.player);
assert.strictEqual(route.player.restarts, 1);
assert.strictEqual(route.player.retry, false);

assert.strictEqual(Player.positionTicks.call({info:{method:'DirectPlay'}, direct:true, hasPlayed:true,
  pendingSeek:null, $:{video:{hasNode:()=>({currentTime:8})}}}), 80000000, 'direct uses media time');
assert.strictEqual(Player.positionTicks.call({info:{method:'MacMini'}, direct:false, hasPlayed:true,
  startTicks:100000000, $:{video:{hasNode:()=>({currentTime:4})}}}), 140000000, 'fMP4 uses media time');

const timeUnit = 10000000;
let preview, previewVisible, position, elapsedFill, clickSuppressed = false;
const seeks = [];
const player = Object.assign(Object.create(Player), {
  playing: true, controlsUp: true, positionTicks: () => 60 * timeUnit,
  durationTicks: () => 300 * timeUnit, seekTo: ticks => seeks.push(ticks),
  $: {
    clock: {setContent: () => {}},
    duration: {setContent: () => {}},
    slider: {setPosition: value => {position = value;}},
    seekFill: {applyStyle: (name, value) => {elapsedFill = value;}},
    seekTrack: {hasNode: () => ({offsetWidth: 800})},
    seekPreview: {setContent: value => {preview = value;}, applyStyle: () => {},
      setShowing: value => {previewVisible = value;}}
  }
});
JF.api = {ticksToClock: ticks => String(ticks / timeUnit)};
player.showPosition(60 * timeUnit);
player.sliderChanging(null, 500);
assert.strictEqual(preview, '150');
assert.strictEqual(elapsedFill, '20%', 'preview does not replace actual progress');
assert.deepStrictEqual(seeks, [], 'dragging alone never opens a new stream');
player.sliderChange(null, 500);
assert.deepStrictEqual(seeks, [150 * timeUnit]);
assert.strictEqual(previewVisible, false);

const surface = {hasNode: () => ({offsetWidth: 1000})};
const finish = {preventClick: () => {clickSuppressed = true;}};
player.stageDragStart(surface, {horizontal: false});
player.stageDrag(surface, {dx: 200});
player.stageDragFinish(surface, finish);
assert.strictEqual(seeks.length, 1, 'vertical drags never seek');
player.stageDragStart(surface, {horizontal: true});
player.stageDrag(surface, {dx: 8});
assert.strictEqual(previewVisible, false, 'small movements are ignored');
player.stageDrag(surface, {dx: 250});
assert.strictEqual(preview, '90');
assert.strictEqual(position, 300);
assert.strictEqual(seeks.length, 1);
player.stageDragFinish(surface, finish);
assert.deepStrictEqual(seeks, [150 * timeUnit, 90 * timeUnit]);
assert.strictEqual(previewVisible, false);
assert.strictEqual(clickSuppressed, true);
player.waitingForRoute = true;
player.sliderChange(null, 800);
assert.strictEqual(seeks.length, 2, 'a pending route is not interrupted by another seek');
assert.strictEqual(position, 200);

function control() {
  return {showing: false, setShowing(value) { this.showing = value; },
    setDisabled(value) { this.disabled = value; },
    setContent(value) { this.content = value; }, setAttribute(key, value) { this[key] = value; },
    applyStyle() {}, addRemoveClass() {}};
}
const node = {currentTime: 20, seeking: false};
Object.assign(player, {
  direct: true, hasPlayed: true, waitingForRoute: false, paused: false,
  moreOpen: false, controlsLocked: false,
  positionTicks: () => node.currentTime * timeUnit,
  showControls: () => {player.controlsUp = true;},
  clearControlsTimer: () => {},
  restartControlsTimer: () => {}
});
for (const name of ['moreScrim', 'morePanel', 'moreButton', 'unlockButton', 'header', 'transport', 'subtitleOverlay',
  'loopLabel', 'setLoopEnd', 'clearLoopButton', 'loopRange']) player.$[name] = control();
player.$.video = {hasNode: () => node};

player.setMoreOpen(true);
assert.strictEqual(player.$.morePanel.showing, true);
assert.strictEqual(player.dismissOverlay(), true, 'back dismisses settings first');
assert.strictEqual(player.$.morePanel.showing, false);
player.lockClick();
assert.strictEqual(player.$.unlockButton.showing, true);
assert.strictEqual(player.$.transport.showing, false);
player.stageClick();
player.stageDragStart(surface, {horizontal: true});
player.stageDrag(surface, {dx: 120});
player.stageDragFinish(surface, finish);
player.sliderChange(null, 700);
assert.strictEqual(seeks.length, 2, 'locked controls do not seek');
assert.strictEqual(player.dismissOverlay(), true, 'back can always unlock');
assert.strictEqual(player.$.unlockButton.showing, false);
assert.strictEqual(player.dismissOverlay(), false);

player.markLoopStart();
assert.strictEqual(player.loopStartTicks, 20 * timeUnit);
node.currentTime = 20.5;
player.markLoopEnd();
assert.strictEqual(player.loopEndTicks, null, 'reversed or sub-second ranges are refused');
node.currentTime = 23;
player.markLoopEnd();
assert.strictEqual(player.loopEndTicks, 23 * timeUnit);
assert.strictEqual(seeks.pop(), 20 * timeUnit, 'marking B returns to A');
player.lockClick();
assert.strictEqual(player.checkLoop(), true, 'lock does not interrupt repeat');
assert.strictEqual(node.currentTime, 20);
player.direct = false;
node.currentTime = 24;
assert.strictEqual(player.checkLoop(), false, 'no restart loop for a live transcode');
player.clearLoopClick();
assert.strictEqual(player.$.loopRange.showing, false);

const cues = JF.parseSrt('\uFEFF1\r\n00:00:01,250 --> 00:00:04,000\r\n<i>第一行</i>\r\nsecond line\r\n\r\n' +
  '2\n00:00:02,000 --> 00:00:02,500\nOverlapping\n\n' +
  '3\n00:00:05,500 --> 00:00:07,000\nAfter seek\n');
assert.strictEqual(cues.length, 3);
assert.strictEqual(JF.subtitleAt(cues, 1), '');
assert.strictEqual(JF.subtitleAt(cues, 2.25), '第一行\nsecond line\nOverlapping');
assert.strictEqual(JF.subtitleAt(cues, 2.5), '第一行\nsecond line');
assert.strictEqual(JF.subtitleAt(cues, 5.5), 'After seek');
assert.strictEqual(JF.subtitleAt(cues, 7), '');
assert.strictEqual(JF.parseSrt('<html>bad response</html>').length, 0);
player.$.subtitleText = control();
Object.assign(player, {subtitleCues:cues, wasShowing:true, waitingForRoute:false, subtitleOffsetMs:250});
node.currentTime = 1.3;
player.renderSubtitle();
assert.strictEqual(player.$.subtitleOverlay.showing, false, 'positive timing delays text');
node.currentTime = 1.55;
player.renderSubtitle();
assert.strictEqual(player.$.subtitleText.content, '第一行\nsecond line');
player.showSubtitle('');
node.currentTime = 5.8;
player.renderSubtitle();
assert.strictEqual(player.$.subtitleText.content, 'After seek');
player.clearTextSubtitle();
assert.strictEqual(player.$.subtitleOverlay.showing, false, 'Off clears text immediately');

player.applySubtitleBackground('invalid');
assert.strictEqual(player.$.subtitleText['data-background'], '90', 'old or invalid preferences use the shaded background');
Object.assign(player, {panelMode:'subtitles', subtitleIndex:1, updateSubtitleOptions() {}});
player.setMoreOpen(true);
player.subtitleBackgroundClick({option:'50'});
assert.strictEqual(preferences['jf.subtitleBackground'], '50');
assert.strictEqual(player.$.subtitleText['data-background'], '50');
assert.strictEqual(player.$.subtitleText.content, 'Subtitle preview', 'a gap between cues still shows a style preview');
player.showSubtitle('Real cue');
assert.strictEqual(player.$.subtitleText.content, 'Real cue', 'the real cue takes precedence');
player.showSubtitle('');
player.setMoreOpen(false);
assert.strictEqual(player.$.subtitleOverlay.showing, false, 'closing the panel clears the sample');

const resumed = [];
Object.assign(player, {
  audioIndex: 2, audioSwitch: {previous:1, target:2, at:300000000},
  startStream: ticks => resumed.push(ticks), moreOpen:false
});
assert.strictEqual(player.restoreAudioTrack(), true);
assert.strictEqual(player.audioIndex, 1);
assert.deepStrictEqual(resumed, [300000000]);
assert.strictEqual(player.restoreAudioTrack(), false, 'an error on the restored track cannot cause a retry loop');

console.log('PASS: player events, route facts, Mini validation, stale guards, recovery and timed subtitles');
