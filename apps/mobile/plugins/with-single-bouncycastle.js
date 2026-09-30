// One BouncyCastle on Android. expo-updates (manifest code signing) brings the jdk15to18 1.81
// artifacts and @pagopa/io-react-native-crypto the jdk18on 1.77 ones: same classes in two jars,
// so the release build fails in checkReleaseDuplicateClasses. Both flavours share the API, so
// every jdk18on module is substituted with its jdk15to18 twin at the newer version.
const { withProjectBuildGradle } = require('expo/config-plugins');

const BC_VERSION = '1.81';
const MARKER = '// with-single-bouncycastle';

const snippet = `
${MARKER}
allprojects {
  configurations.all {
    resolutionStrategy.dependencySubstitution {
${['bcprov', 'bcpkix', 'bcutil']
  .map(
    (m) =>
      `      substitute module('org.bouncycastle:${m}-jdk18on') using module('org.bouncycastle:${m}-jdk15to18:${BC_VERSION}')`,
  )
  .join('\n')}
    }
  }
}
`;

module.exports = function withSingleBouncyCastle(config) {
  return withProjectBuildGradle(config, (cfg) => {
    if (!cfg.modResults.contents.includes(MARKER)) {
      cfg.modResults.contents += snippet;
    }
    return cfg;
  });
};
