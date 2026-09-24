/**
 * Babel config for the Kshema Expo app.
 *
 * `babel-preset-expo` is configured with the NativeWind JSX runtime so that
 * `className` props on React Native components compile to the shared brand
 * tokens defined in `@kshema/ui` (via tailwind.config.js). File-based routing
 * from `expo-router` is wired by `babel-preset-expo` in SDK 50+, so the legacy
 * `expo-router/babel` plugin is no longer needed (and errors if present).
 */
module.exports = function babelConfig(api) {
  api.cache(true);
  return {
    presets: [["babel-preset-expo", { jsxImportSource: "nativewind" }], "nativewind/babel"],
  };
};
