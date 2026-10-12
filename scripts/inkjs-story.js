'use strict';

/**
 * Loads Ink source or compiled Ink JSON and returns an InkJS Story instance.
 * Used by both the sequence bot and the generic player's Ink adapter.
 */

const fs = require('fs');
const path = require('path');
const { Story } = require('inkjs');

function loadInkStory(storyPath) {
  const absolutePath = path.resolve(storyPath);
  const source = fs.readFileSync(absolutePath, 'utf8').replace(/^\uFEFF/, '');
  return compileInkStory(source, path.extname(absolutePath));
}

function compileInkStory(content, extension) {
  const source = Buffer.isBuffer(content) ? content.toString('utf8').replace(/^\uFEFF/, '') : String(content).replace(/^\uFEFF/, '');

  if (String(extension).toLowerCase() === '.ink') {
    const { Compiler } = require('inkjs/full');
    const story = new Compiler(source).Compile();
    if (!story) throw new Error('InkJS could not compile the Ink source.');
    return story;
  }

  if (String(extension).toLowerCase() === '.json') {
    return new Story(JSON.parse(source));
  }

  throw new Error('Story input must be Ink source (.ink) or compiled Ink JSON (.json).');
}

module.exports = { loadInkStory, compileInkStory };
