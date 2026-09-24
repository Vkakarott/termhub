// `react-native-markdown-display` under jest (test/ui-setup.js): the source text in a `Text`
// tagged `markdown`, so a test can tell an assistant's markdown bubble from a plain one.
const React = require('react');
const { Text } = require('react-native');

function Markdown({ children }) {
  return React.createElement(Text, { testID: 'markdown' }, children);
}

module.exports = { __esModule: true, default: Markdown };
