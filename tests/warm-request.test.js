const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const storage = {'jf.miniBridge':'http://192.168.50.20:18099/v1/PublicFixtureCapability0123456789'};
const requests = [];
const timers = [];
const sandbox = {
  window:{JF:{}},
  localStorage:{getItem:key=>storage[key] || ''},
  XMLHttpRequest:function FakeXHR() {
    this.headers = {};
    requests.push(this);
  },
  setTimeout:(fn, ms)=>{ timers.push({fn:fn, ms:ms, cancelled:false}); return timers.length; },
  clearTimeout:id=>{ if (timers[id - 1]) timers[id - 1].cancelled = true; },
  console:{log(){}, warn(){}, error(){}}
};
sandbox.XMLHttpRequest.prototype.open = function(method, url, async) {
  this.method = method;
  this.url = url;
  this.async = async;
};
sandbox.XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
  this.headers[name] = value;
};
sandbox.XMLHttpRequest.prototype.send = function() { this.sent = true; };
sandbox.XMLHttpRequest.prototype.abort = function() {
  this.aborted = true;
  if (this.onabort) this.onabort();
};

vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app/source/Compatibility.js'), 'utf8'), sandbox);
const JF = sandbox.JF;
JF.miniWarmEnabled = true;
JF.api = {query:obj=>'?'+Object.keys(obj).filter(k=>obj[k]!==null&&obj[k]!==undefined&&obj[k]!=='')
  .map(k=>encodeURIComponent(k)+'='+encodeURIComponent(obj[k])).join('&')};
const stream = JF.miniVideoUrl({Id:'movie/one'}, {Id:'source two'}, 1, 300000000);
const expectedWarm = 'http://192.168.50.20:18099/v1/PublicFixtureCapability0123456789/warm/movie%2Fone' +
  '?startSeconds=30&audioStreamIndex=1&mediaSourceId=source%20two&format=mkv';
assert(stream.indexOf('/stream/movie%2Fone?') >= 0, 'test uses the existing exact Mini stream route');

function respond(request, status, body) {
  request.status = status;
  request.responseText = body === undefined ? '' : JSON.stringify(body);
  request.readyState = 4;
  request.onreadystatechange();
}
function lastTimer() { return timers[timers.length - 1]; }

let answer = null;
let cancel = JF.prepareMiniVideo(stream, (url, reason)=>{ answer = {url:url, reason:reason}; });
assert.strictEqual(requests.length, 1, 'one warm request is issued');
assert.strictEqual(requests[0].method, 'GET');
assert.strictEqual(requests[0].url, expectedWarm, 'warm keeps the selected item and exact stream query');
assert.deepStrictEqual(requests[0].headers, {Accept:'application/json'}, 'warm uses only the capability path, not an Emby token');
assert.strictEqual(lastTimer().ms, 34000, 'warm has a bounded 34 second timeout');
assert.strictEqual(typeof cancel, 'function', 'warm returns a cancel function');
respond(requests[0], 200, {returnValue:true, sessionId:'0123456789abcdef0123456789abcdef',
  url:'http://attacker.invalid/should-not-be-used'});
assert.deepStrictEqual(answer, {
  url:'http://192.168.50.20:18099/v1/PublicFixtureCapability0123456789/ready/0123456789abcdef0123456789abcdef',
  reason:null
}, 'success constructs the ready URL from the validated base and session id');

answer = null;
JF.prepareMiniVideo(stream, (url, reason)=>{ answer = {url:url, reason:reason}; });
respond(requests[1], 200, {returnValue:true, sessionId:'0123456789ABCDEF0123456789abcdef'});
assert.deepStrictEqual(answer, {url:'', reason:'invalid'}, 'uppercase or malformed session ids are rejected');

answer = null;
JF.prepareMiniVideo(stream, (url, reason)=>{ answer = {url:url, reason:reason}; });
respond(requests[2], 200, {returnValue:false, sessionId:'0123456789abcdef0123456789abcdef'});
assert.deepStrictEqual(answer, {url:'', reason:'invalid'}, 'a mismatched success envelope is rejected');

answer = null;
const beforeCancel = requests.length;
cancel = JF.prepareMiniVideo(stream, (url, reason)=>{ answer = {url:url, reason:reason}; });
assert.strictEqual(requests.length, beforeCancel + 1);
cancel();
assert.strictEqual(requests[3].aborted, true, 'cancel aborts the in-flight request');
respond(requests[3], 200, {returnValue:true, sessionId:'0123456789abcdef0123456789abcdef'});
assert.strictEqual(answer, null, 'cancel suppresses the callback');

answer = null;
JF.prepareMiniVideo(stream, (url, reason)=>{ answer = {url:url, reason:reason}; });
const timeout = lastTimer();
timeout.fn();
assert.deepStrictEqual(answer, {url:'', reason:'timeout'}, 'timeout fails once and aborts the request');
assert.strictEqual(requests[4].aborted, true);

answer = null;
JF.prepareMiniVideo('https://emby.example/Videos/movie/stream.mkv', (url, reason)=>{ answer = {url:url, reason:reason}; });
assert.strictEqual(requests.length, 5, 'direct server URLs are rejected without a request');
assert.deepStrictEqual(answer, {url:'', reason:'invalid'});

answer = null;
JF.prepareMiniVideo(stream, (url, reason)=>{ answer = {url:url, reason:reason}; });
respond(requests[5], 429, {returnValue:false});
assert.deepStrictEqual(answer, {url:'', reason:'busy'}, '429 is reported as a retryable generic busy result');

answer = null;
JF.prepareMiniVideo(stream, (url, reason)=>{ answer = {url:url, reason:reason}; });
respond(requests[6], 415, {returnValue:false});
assert.deepStrictEqual(answer, {url:'', reason:'unsupported'}, '415 is reported without exposing bridge details');

console.log('PASS: bounded Mini warm request, strict ready URL, cancellation and failure handling');
