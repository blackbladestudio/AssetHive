const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('character selection feedback matches the active class emitted by AssetCard', () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/ui/App.tsx'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/ui/styles.css'), 'utf8');
  assert.match(app, /isSelected \? "active"/);
  assert.match(css, /\.fixed-character-cards \.character-card\.active,\s*\.fixed-character-cards \.character-card\.selected\s*\{[^}]*--card-zoom: 1\.04/);
  assert.match(css, /\.fixed-character-cards \.character-card:active:not\(\.saving\)\s*\{[^}]*--card-zoom: 1\.04/);
  assert.match(css, /--card-zoom: \.92/);
  assert.match(css, /scale: var\(--card-zoom, 1\)/);
  assert.match(app, /translate: `\$\{x\}px \$\{y\}px`/);
  assert.match(css, /transition: scale 220ms/);
  assert.match(css, /character-card\.active:hover \{ box-shadow:/);
  assert.match(app, /classList.add\("character-click-feedback"\)/);
  assert.match(app, /card\.closest\("\.overview-packed-grid"\)/);
  assert.match(app, /onPointerCancel=/);
  assert.match(app, /prefers-reduced-motion: reduce/);
  assert.match(css, /overview-packed-grid \.character-card::after \{ display: none/);
});
