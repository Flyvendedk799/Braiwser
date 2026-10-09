// The welcome page's "Go" box must not treat host:port or a Windows drive path
// as a URL scheme. Its inline resolver is extracted from the page and run here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const html = fs.readFileSync(path.resolve(import.meta.dirname, '../../src/renderer/welcome.html'), 'utf8').replace(/\r\n/g, '\n');
const m = /function fileUrl[\s\S]*?\n {6}function resolve[\s\S]*?\n {6}\}\n/.exec(html);
assert.ok(m, 'resolver found in welcome.html');
const ctx = vm.createContext({ encodeURIComponent });
vm.runInContext(m[0], ctx);
const resolve = (s) => vm.runInContext(`resolve(${JSON.stringify(s)})`, ctx);

test('hosts, ports and domains', () => {
  assert.equal(resolve('localhost:3000'), 'http://localhost:3000');
  assert.equal(resolve('127.0.0.1:8080/app'), 'http://127.0.0.1:8080/app');
  assert.equal(resolve('example.com/x'), 'https://example.com/x');
  assert.equal(resolve('https://a.test/p?q=1'), 'https://a.test/p?q=1');
});

test('paths become file: URLs, not https://C:...', () => {
  assert.equal(resolve('C:\\site\\index.html'), 'file:///C:/site/index.html');
  assert.equal(resolve('C:/my site/a.html'), 'file:///C:/my%20site/a.html');
  assert.equal(resolve('/home/me/site/index.html'), 'file:///home/me/site/index.html');
  assert.equal(resolve('\\\\server\\share\\x.html'), 'file://server/share/x.html');
});

test('plain words search instead of becoming https://word', () => {
  assert.match(resolve('how to center a div'), /^https:\/\/www\.google\.com\/search\?q=how%20to/);
  assert.match(resolve('hello'), /search\?q=hello$/);
});
