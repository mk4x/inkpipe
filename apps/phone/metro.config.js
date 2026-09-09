// Metro in an npm workspace.
//
// Two things are needed that a standalone app does not require:
//   watchFolders  so edits to @inkpipe/crypto and friends trigger a rebuild
//   nodeModulesPaths  so a dependency hoisted to the repo root still resolves
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// Prefer the app's own copy, so the React version Expo needs wins over the one
// the desktop UI pulled to the root.
config.resolver.disableHierarchicalLookup = false;
// The shared packages ship TypeScript source, with no build step anywhere.
config.resolver.sourceExts = [...config.resolver.sourceExts, 'ts', 'tsx'];

module.exports = config;
