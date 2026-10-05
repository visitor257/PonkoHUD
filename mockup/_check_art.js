const fs = require('fs');
const html = fs.readFileSync(process.argv[2], 'utf8');
const code = html.split('/*PIXEL-BEGIN*/')[1].split('/*PIXEL-END*/')[0];
const { build, W, H } = new Function(code + '\nreturn { build, W, H };')();

const MAP = {
  '#0b1a26': '.',
  '#3f6fd8': 'H', '#7aa6ff': 'h', '#2a4e9e': 'd',
  '#f6cfb5': 'S', '#e3b096': 's',
  '#12305c': 'E', '#ffffff': 'W', '#f19a9a': 'b',
  '#3a6bd0': 'D', '#eef4ff': 'A', '#e8eff8': 'K', '#1e3a6e': 'B',
  '#6a9cf0': 'F', '#93bcff': 'z', '#ffe08a': '*', '#8fd8ff': 'T', '#8a4a52': 'm'
};

for (const st of ['idle', 'think', 'sleepy', 'error']) {
  const g = build(st);
  console.log('=== ' + st + ' ===');
  for (let y = 0; y < H; y++) {
    let line = '';
    for (let x = 0; x < W; x++) line += (MAP[g[y][x]] || '?');
    console.log(line);
  }
  console.log('');
}
