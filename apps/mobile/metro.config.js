/**
 * Metro bundler config for the Kshema Expo app inside the pnpm monorepo.
 *
 * Two monorepo-specific concerns are handled here:
 *   1. `watchFolders` includes the workspace root so Metro can resolve the
 *      linked `@kshema/*` workspace packages (types, encryption, ui).
 *   2. `nodeModulesPaths` lets Metro walk up to the hoisted root
 *      `node_modules` in addition to the app-local one.
 *
 * NativeWind's Metro transformer is applied so the global Tailwind stylesheet
 * (`global.css`) is processed for React Native.
 */
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = false;

/**
 * The domain/store/platform source uses NodeNext/ESM-style relative imports
 * with explicit `.js` extensions (e.g. `./session-slice.js`) so the framework
 * -agnostic domain layer typechecks under `tsconfig.domain.json` and runs in
 * Vitest. Metro resolves against the on-disk `.ts`/`.tsx` sources, so strip a
 * trailing `.js` from relative specifiers and let Metro's normal extension
 * resolution find the TypeScript source. Non-relative (package) imports and
 * real `.js` files are left untouched.
 */
/**
 * Node-core-module aliases for React Native.
 *
 * The shared `@kshema/encryption` package targets Node's `crypto`/`zlib` and
 * the `Buffer` global (one implementation shared with api/worker/web). Hermes
 * has none, so we alias those specifiers to native/JS RN equivalents installed
 * by `src/crypto-polyfill.ts`:
 *   - `crypto` / `node:crypto` -> react-native-quick-crypto (native AES-GCM +
 *     RSA-OAEP JSI implementation, a Node `crypto` drop-in),
 *   - `zlib`   / `node:zlib`   -> local pako-backed gzip shim (envelope only
 *     uses gzipSync/gunzipSync; avoids browserify-zlib's assert/stream chain),
 *   - `buffer` / `node:buffer` -> @craftzdog/react-native-buffer,
 *   - `stream` / `node:stream` -> stream-browserify (transitive dep of the above).
 */
const nodeCoreAliases = {
  crypto: require.resolve("react-native-quick-crypto"),
  "node:crypto": require.resolve("react-native-quick-crypto"),
  zlib: path.resolve(projectRoot, "src/zlib-shim.ts"),
  "node:zlib": path.resolve(projectRoot, "src/zlib-shim.ts"),
  buffer: require.resolve("@craftzdog/react-native-buffer"),
  "node:buffer": require.resolve("@craftzdog/react-native-buffer"),
  stream: require.resolve("stream-browserify"),
  "node:stream": require.resolve("stream-browserify"),
};

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const alias = nodeCoreAliases[moduleName];
  if (alias) {
    return { type: "sourceFile", filePath: alias };
  }

  let target = moduleName;
  // The domain/store/platform source uses NodeNext/ESM-style relative imports
  // with explicit `.js` extensions (e.g. `./session-slice.js`) so the domain
  // layer typechecks under `tsconfig.domain.json` and runs in Vitest. Metro
  // resolves against the on-disk `.ts`/`.tsx` sources, so strip a trailing
  // `.js` from relative specifiers and let Metro's normal extension resolution
  // find the TypeScript source. Package imports and real `.js` files are left
  // untouched.
  if (
    (moduleName.startsWith("./") || moduleName.startsWith("../")) &&
    moduleName.endsWith(".js")
  ) {
    target = moduleName.slice(0, -3);
  }
  const resolve = defaultResolveRequest ?? context.resolveRequest;
  return resolve(context, target, platform);
};

module.exports = withNativeWind(config, { input: "./global.css" });
