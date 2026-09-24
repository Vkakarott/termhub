// `react-native-markdown-display` under jest (test/ui-setup.js): the source text in a `Text`
// tagged `markdown`, so a test can tell an assistant's markdown bubble from a plain one. Every
// render appends its source to `renders`, so a test can check which bubbles re-rendered.
const React = require('react');
const { Text } = require('react-native');

const renders = [];

function Markdown({ children }) {
  renders.push(children);
  return React.createElement(Text, { testID: 'markdown' }, children);
}

module.exports = { __esModule: true, default: Markdown, renders };
