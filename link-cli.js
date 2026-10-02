'use strict';

const fs = require('node:fs');
const path = require('node:path');
const link = path.join(__dirname, 'CLI');
const target = path.resolve(__dirname, '../CLI');
if (!fs.existsSync(path.join(target, 'lib.js'))) throw new Error('The sibling CLI directory is missing.');
if (fs.existsSync(link)) {
  console.log('CLI already exists; leaving it unchanged.');
} else {
  fs.symlinkSync(process.platform === 'win32' ? target : '../CLI', link, process.platform === 'win32' ? 'junction' : 'dir');
  console.log('CLI linked to ../CLI');
}
