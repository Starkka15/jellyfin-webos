const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../app/source/Api.js'), 'utf8');
const embyUrl = 'http://emby.example.invalid';
function itemPath(useEmby) {
  let requested, calls = 0;
  const sandbox = {
    window: {JF:{}}, console, setTimeout, clearTimeout,
    localStorage: {getItem:key=>key === 'jf.embyUrl' && useEmby ? embyUrl : ''},
    XMLHttpRequest: function() {
      this.open = (method, url) => {assert.strictEqual(method, 'GET'); requested = url;};
      this.setRequestHeader = () => {};
      this.send = () => {
        this.status = 200; this.responseText = '{"Id":"movie"}'; this.readyState = 4;
        this.onreadystatechange(); this.onreadystatechange();
      };
    }
  };
  vm.runInNewContext(source, sandbox);
  const api = sandbox.JF.api;
  api.baseUrl = api.signedInUrl = useEmby ? embyUrl : 'http://jellyfin.example.invalid';
  api.userId = 'user /?';
  api.authHeader = () => 'test';
  api.item('movie /?', (ok, data, status) => {
    calls++;
    assert.strictEqual(ok, true);
    assert.strictEqual(status, 200);
    assert.strictEqual(data.Id, 'movie');
  });
  assert.strictEqual(calls, 1);
  return new URL(requested).pathname;
}
assert.strictEqual(itemPath(true), '/Users/user%20%2F%3F/Items/movie%20%2F%3F');
assert.strictEqual(itemPath(false), '/Items/movie%20%2F%3F');
console.log('PASS: Emby and Jellyfin item endpoints, URL encoding, and single callback');
