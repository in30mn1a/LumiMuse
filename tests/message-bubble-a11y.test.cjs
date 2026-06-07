const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const source = readFileSync('src/components/chat/MessageBubble.tsx', 'utf8');

test('message action toolbar becomes visible when keyboard focus enters it', () => {
  const toolbarMatch = source.match(/<div className=\{`ml-auto flex[\s\S]*?\`}>\s*\{\s*\/\* 复制/);
  const buttonBaseMatch = source.match(/const btnBase = '([^']+)'/);

  assert.ok(toolbarMatch, 'expected to find the message action toolbar');
  assert.ok(buttonBaseMatch, 'expected to find the shared message action button class');
  const toolbar = toolbarMatch[0];
  const buttonBase = buttonBaseMatch[1];

  assert.match(toolbar, /group-focus-within:opacity-100/);
  assert.match(toolbar, /pointer-events-none/);
  assert.match(toolbar, /group-focus-within:pointer-events-auto/);
  assert.match(toolbar, /group-hover:pointer-events-auto/);
  assert.match(buttonBase, /focus-visible:outline/);
  assert.match(buttonBase, /focus-visible:outline-offset-2/);
});

test('generated image hover toolbar is also visible and clickable on keyboard focus', () => {
  const toolbarMatch = source.match(/<div className=\{`absolute right-2 top-2 flex gap-1[\s\S]*?\`}>\s*<button/);
  const buttonClasses = [...source.matchAll(/className="rounded-lg bg-black\/50[^"]+"/g)].map(match => match[0]);

  assert.ok(toolbarMatch, 'expected to find the generated image action toolbar');
  assert.equal(buttonClasses.length, 3, 'expected generated image toolbar to have three action buttons');
  const toolbar = toolbarMatch[0];

  assert.match(toolbar, /group-focus-within\/img:opacity-100/);
  assert.match(toolbar, /pointer-events-none/);
  assert.match(toolbar, /group-focus-within\/img:pointer-events-auto/);
  assert.match(toolbar, /group-hover\/img:pointer-events-auto/);
  for (const buttonClass of buttonClasses) {
    assert.match(buttonClass, /focus-visible:outline/);
    assert.match(buttonClass, /focus-visible:outline-offset-2/);
  }
});
