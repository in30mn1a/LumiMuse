const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const source = readFileSync('src/components/chat/MessageBubble.tsx', 'utf8');

function sourceBlock(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('message action toolbar becomes visible when keyboard focus enters it', () => {
  const toolbar = sourceBlock('className={`ml-auto flex', '{/* 复制');
  const buttonBaseMatch = source.match(/const btnBase = '([^']+)'/);

  assert.ok(buttonBaseMatch, 'expected to find the shared message action button class');
  const buttonBase = buttonBaseMatch[1];

  assert.match(toolbar, /group-focus-within:opacity-100/);
  assert.match(toolbar, /pointer-events-none/);
  assert.match(toolbar, /group-focus-within:pointer-events-auto/);
  assert.match(toolbar, /group-hover:pointer-events-auto/);
  assert.match(toolbar, /\[@media\(hover:none\)\]:pointer-events-auto/);
  assert.match(toolbar, /\[@media\(hover:none\)\]:opacity-100/);
  assert.match(buttonBase, /focus-visible:outline/);
  assert.match(buttonBase, /focus-visible:outline-offset-2/);
});

test('generated image hover toolbar is also visible and clickable on keyboard focus', () => {
  const toolbar = sourceBlock('className={`absolute right-2 top-2 flex gap-1', '<button');
  const buttonClasses = [...source.matchAll(/className="rounded-lg bg-black\/50[^"]+"/g)].map(match => match[0]);

  assert.equal(buttonClasses.length, 3, 'expected generated image toolbar to have three action buttons');

  assert.match(toolbar, /group-focus-within\/img:opacity-100/);
  assert.match(toolbar, /pointer-events-none/);
  assert.match(toolbar, /group-focus-within\/img:pointer-events-auto/);
  assert.match(toolbar, /group-hover\/img:pointer-events-auto/);
  assert.match(toolbar, /\[@media\(hover:none\)\]:pointer-events-auto/);
  assert.match(toolbar, /\[@media\(hover:none\)\]:opacity-100/);
  for (const buttonClass of buttonClasses) {
    assert.match(buttonClass, /focus-visible:outline/);
    assert.match(buttonClass, /focus-visible:outline-offset-2/);
  }
});
