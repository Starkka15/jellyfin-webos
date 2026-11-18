const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');

const base = path.join(__dirname, '../app/source');
const kinds = {};
const sandbox = {
  JF: {},
  console,
  enyo: {
    VFlexBox: {},
    isArray: Array.isArray,
    kind: definition => { kinds[definition.name] = definition; }
  }
};
vm.runInNewContext(fs.readFileSync(path.join(base, 'HomeView.js'), 'utf8'), sandbox);
vm.runInNewContext(fs.readFileSync(path.join(base, 'NetworkLibraryView.js'), 'utf8'), sandbox);
const Home = kinds['JF.HomeView'];
const Network = kinds['JF.NetworkLibraryView'];

assert.ok(Object.prototype.hasOwnProperty.call(Home.events, 'onOpenNetworkSource'),
  'home exposes the network-source event');
const homeScroller = Home.components[1];
const networkButtons = homeScroller.components[2].components;
assert.strictEqual(homeScroller.components[1].content, 'Network Sources');
assert.deepStrictEqual(Array.prototype.map.call(networkButtons, button => button.caption), ['NAS', 'AList']);
const opened = [];
Home.nasClick.call({doOpenNetworkSource: source => opened.push(source)});
Home.alistClick.call({doOpenNetworkSource: source => opened.push(source)});
assert.deepStrictEqual(opened, ['nas', 'alist'], 'home buttons use stable source ids');

let browseCallback = null;
const browseCalls = [];
sandbox.JF.networkBrowse = (source, pathArray, callback) => {
  browseCalls.push({source, path: Array.prototype.slice.call(pathArray)});
  browseCallback = callback;
};
function viewState() {
  const rendered = [];
  const messages = [];
  const view = Object.assign({}, Network, {
    $: {
      title: {setContent: value => { view.title = value; }},
      scroller: {setScrollTop: value => { view.scrollTop = value; }},
      path: {setContent: value => { view.pathText = value; }},
      message: {setContent: value => { messages.push(value); view.message = value; }},
      entries: {
        destroyControls: () => { rendered.length = 0; },
        createComponent: component => { rendered.push(component); return component; },
        render: () => { view.rendered = rendered.slice(0); }
      }
    },
    rendered,
    messages,
    doPlayNetworkFile: (source, pathArray) => {
      view.played = {source, path: Array.prototype.slice.call(pathArray)};
    },
    doCloseNetworkSource: () => { view.closed = true; }
  });
  return view;
}

const view = viewState();
view.open('nas');
assert.strictEqual(view.title, 'NAS');
assert.deepStrictEqual(browseCalls[0], {source: 'nas', path: []});
browseCallback(true, {entries: [
  {name: 'Movies', directory: true, playable: false},
  {name: 'clip.mp4', directory: false, playable: true},
  {name: 'notes.txt', directory: false, playable: false}
]});
assert.strictEqual(view.message, '');
assert.strictEqual(view.rendered.length, 3);
assert.strictEqual(view.rendered[0].components[1].content, 'Folder');
assert.strictEqual(view.rendered[1].components[1].content, 'Play');
assert.strictEqual(view.rendered[2].components[1].content, 'Unavailable');

view.entryClick(view.rendered[0]);
assert.deepStrictEqual(browseCalls[1], {source: 'nas', path: ['Movies']});
browseCallback(true, {entries: [{name: 'film.m4v', directory: false, playable: true}]});
view.entryClick(view.rendered[0]);
assert.deepStrictEqual(view.played, {source: 'nas', path: ['Movies', 'film.m4v']});

view.backClick();
assert.deepStrictEqual(browseCalls[2], {source: 'nas', path: []});
view.backClick();
assert.strictEqual(view.closed, true, 'back at the root closes the source view');

// A late response from an earlier source must not replace the current listing.
const stale = viewState();
let firstCallback;
sandbox.JF.networkBrowse = (source, pathArray, callback) => {
  if (source === 'nas') firstCallback = callback;
  else callback(true, {entries: [{name: 'AList item', playable: true}]});
};
stale.open('nas');
stale.open('alist');
firstCallback(true, {entries: [{name: 'stale.mp4', playable: true}]});
assert.strictEqual(stale.rendered.length, 1);
assert.strictEqual(stale.rendered[0].entry.name, 'AList item');

console.log('PASS: network source buttons, browsing, streaming handoff, root back and stale response guard');
