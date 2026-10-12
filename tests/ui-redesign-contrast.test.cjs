const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '../src/app/globals.css'), 'utf8');
const lightBlock = css.match(/@theme\s*\{([\s\S]*?)\n\}/)?.[1];
const darkBlock = css.match(/\.dark\s*\{([\s\S]*?)\n\}/)?.[1];
assert.ok(lightBlock && darkBlock, 'light and dark color tokens must be available');

function tokens(block) {
  return Object.fromEntries([...block.matchAll(/--color-([\w-]+):\s*(#[\da-f]{6});/gi)].map(([, name, color]) => [name, color]));
}

function rgb(hex) {
  assert.match(hex || '', /^#[\da-f]{6}$/i, 'contrast checks require a resolved color');
  return hex.slice(1).match(/../g).map(channel => parseInt(channel, 16));
}

function luminance(color) {
  const linear = color.map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function ratio(foreground, background) {
  const first = luminance(foreground), second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function mix(foreground, background, opacity) {
  return foreground.map((channel, index) => channel * opacity + background[index] * (1 - opacity));
}

for (const [theme, colors] of [['light', tokens(lightBlock)], ['dark', tokens(darkBlock)]]) {
  test(`${theme} normal text meets AA contrast on the common semantic surfaces`, () => {
    for (const text of ['text-primary', 'text-secondary', 'text-muted']) {
      for (const surface of ['page', 'surface', 'surface-raised', 'surface-2', 'surface-3']) {
        const contrast = ratio(rgb(colors[text]), rgb(colors[surface]));
        assert.ok(contrast >= 4.5, `${theme} ${text}/${surface}: ${contrast.toFixed(2)} < 4.5`);
      }
    }
  });

  test(`${theme} primary and destructive buttons retain readable text in normal and hover states`, () => {
    const solid = rgb(colors['accent-solid']);
    assert.ok(ratio(rgb('#ffffff'), solid) >= 4.5, `${theme} primary button`);
    assert.ok(ratio(rgb('#ffffff'), mix(solid, rgb('#000000'), 0.88)) >= 4.5, `${theme} primary button hover`);
    for (const surface of ['page', 'surface', 'surface-2']) {
      for (const opacity of [0.1, 0.16]) {
        const danger = rgb(colors.danger);
        const contrast = ratio(danger, mix(danger, rgb(colors[surface]), opacity));
        assert.ok(contrast >= 4.5, `${theme} danger/${surface} ${opacity}: ${contrast.toFixed(2)} < 4.5`);
      }
    }
  });

  test(`${theme} active chips and user bubbles have AA text contrast`, () => {
    const accent = rgb(colors.accent);
    for (const surface of ['page', 'surface']) {
      assert.ok(ratio(rgb(colors['accent-dark']), mix(accent, rgb(colors[surface]), 0.14)) >= 4.5, `${theme} active chip/${surface}`);
    }
    const bubble = (theme === 'light' ? lightBlock : darkBlock).match(/--bubble-user-bg:\s*(#[\da-f]{6});/i)?.[1];
    assert.ok(ratio(rgb('#ffffff'), rgb(bubble)) >= 4.5, `${theme} user bubble`);
  });
}
