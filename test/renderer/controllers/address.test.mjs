import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAddress, pathToFileUrl, dirnameOf, localTarget, matchesLocalTarget, basenameOf } from '../../../src/renderer/lib/address.js';

test('full URLs and opaque schemes pass through', () => {
  assert.equal(resolveAddress('https://example.com/a?b=1#c'), 'https://example.com/a?b=1#c');
  assert.equal(resolveAddress('http://localhost:3000/x'), 'http://localhost:3000/x');
  assert.equal(resolveAddress('about:blank'), 'about:blank');
  assert.equal(resolveAddress('data:text/html,hi'), 'data:text/html,hi');
  assert.equal(resolveAddress('file:///C:/a/b.html'), 'file:///C:/a/b.html');
  assert.equal(resolveAddress('  '), '');
  assert.equal(resolveAddress(null), '');
});

test('Windows drive paths become file URLs (not https://C:\\...)', () => {
  assert.equal(resolveAddress('C:\\site\\index.html'), 'file:///C:/site/index.html');
  assert.equal(resolveAddress('d:/My Site/ünï.html'), 'file:///d:/My%20Site/%C3%BCn%C3%AF.html');
  assert.equal(resolveAddress('C:\\'), 'file:///C:/');
  assert.equal(resolveAddress('C:\\a#b\\c?.html'), 'file:///C:/a%23b/c%3F.html');
});

test('UNC paths become file://host/share URLs', () => {
  assert.equal(resolveAddress('\\\\server\\share\\dir\\p.html'), 'file://server/share/dir/p.html');
  assert.equal(resolveAddress('\\\\srv\\a b\\x.html'), 'file://srv/a%20b/x.html');
});

test('POSIX absolute paths become encoded file URLs', () => {
  assert.equal(resolveAddress('/home/me/site/index.html'), 'file:///home/me/site/index.html');
  assert.equal(resolveAddress('/tmp/with space/a.html'), 'file:///tmp/with%20space/a.html');
});

test('file: forms normalise', () => {
  assert.equal(resolveAddress('file:C:\\x\\y.html'), 'file:///C:/x/y.html');
  assert.equal(resolveAddress('file:/C:/x/y.html'), 'file:///C:/x/y.html');
});

test('localhost, loopback, LAN and ports are http, never a search', () => {
  assert.equal(resolveAddress('localhost'), 'http://localhost');
  assert.equal(resolveAddress('localhost:3000'), 'http://localhost:3000');
  assert.equal(resolveAddress('localhost:3000/app?x=1'), 'http://localhost:3000/app?x=1');
  assert.equal(resolveAddress('127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.equal(resolveAddress('192.168.1.5:5173/x'), 'http://192.168.1.5:5173/x');
  assert.equal(resolveAddress('[::1]:3000'), 'http://[::1]:3000');
  assert.equal(resolveAddress('app.localhost:4000'), 'http://app.localhost:4000');
  assert.equal(resolveAddress('myserver:8080'), 'http://myserver:8080');
  assert.equal(resolveAddress('example.com:8443/p'), 'https://example.com:8443/p');
});

test('bare domains get https, other text is a search', () => {
  assert.equal(resolveAddress('example.com'), 'https://example.com');
  assert.equal(resolveAddress('example.com/path?q=1'), 'https://example.com/path?q=1');
  assert.match(resolveAddress('how do I center a div'), /^https:\/\/www\.google\.com\/search\?q=how%20do%20I/);
  assert.match(resolveAddress('hello'), /google\.com\/search/);
  assert.match(resolveAddress('javascript:alert(1)'), /google\.com\/search/);
});

test('pathToFileUrl / dirnameOf / basenameOf', () => {
  assert.equal(pathToFileUrl('C:\\a\\b'), 'file:///C:/a/b');
  assert.equal(dirnameOf('C:\\site\\index.html'), 'C:\\site');
  assert.equal(dirnameOf('C:\\index.html'), 'C:\\');
  assert.equal(dirnameOf('/a/b/c.html'), '/a/b');
  assert.equal(dirnameOf('/c.html'), '/');
  assert.equal(basenameOf('C:\\site\\index.html'), 'index.html');
  assert.equal(basenameOf('/a/b/'), 'b');
});

test('MB-01: Open File targets a DIRECTORY plus entry; Open Folder keeps its entry', () => {
  const f = localTarget('file', { path: 'C:\\My Sites\\Ünï\\page.html', url: 'file:///x' });
  assert.deepEqual(f, { name: 'page.html', path: 'C:\\My Sites\\Ünï', entry: 'C:\\My Sites\\Ünï\\page.html' });
  const d = localTarget('folder', { path: '/home/me/site', entry: '/home/me/site/index.html' });
  assert.deepEqual(d, { name: 'site', path: '/home/me/site', entry: '/home/me/site/index.html' });
  assert.equal(localTarget('file', null), null);
});

test('matchesLocalTarget finds existing and legacy (path = file) projects', () => {
  const t = localTarget('file', { path: '/w/a b/p.html' });
  assert.ok(matchesLocalTarget({ path: '/w/a b', entry: '/w/a b/p.html' }, t));
  assert.ok(matchesLocalTarget({ path: '/w/a b/p.html' }, t)); // legacy
  assert.ok(!matchesLocalTarget({ path: '/w/a b', entry: '/w/a b/other.html' }, t));
  const folder = localTarget('folder', { path: '/w/site' });
  assert.ok(matchesLocalTarget({ path: '/w/site/' }, folder));
  assert.ok(!matchesLocalTarget({ path: '/w/site', entry: '/w/site/x.html' }, folder));
});
