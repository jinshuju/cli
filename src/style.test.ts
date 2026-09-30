import test from 'node:test';
import assert from 'node:assert/strict';

import { PLAIN, styleFor } from './style.js';

test('a pipe has no style at all', () => {
  assert.equal(styleFor({ isTTY: false }, {}), undefined);
  assert.equal(styleFor({}, {}), undefined);
});

test('NO_COLOR keeps the terminal and drops the colour', () => {
  assert.equal(styleFor({ isTTY: true }, { NO_COLOR: '1' }), PLAIN);
});

test('the heading is the logo orange, in 24-bit where the terminal says it can', () => {
  assert.equal(styleFor({ isTTY: true }, { COLORTERM: 'truecolor' })?.heading('x'), '\x1b[38;2;255;133;51mx\x1b[39m');
  assert.equal(styleFor({ isTTY: true }, { COLORTERM: '24bit' })?.heading('x'), '\x1b[38;2;255;133;51mx\x1b[39m');
  assert.equal(styleFor({ isTTY: true }, {})?.heading('x'), '\x1b[38;5;209mx\x1b[39m');
});
