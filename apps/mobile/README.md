# @kshema/mobile

The Kshema Anchor/Observer mobile app — Expo (SDK 51+) + React Native (0.74+),
NativeWind wired to the shared `@kshema/ui` brand tokens, Zustand stores, and
Expo Router for role-based surfaces.

## Layout

```
app/                     # Expo Router file-based routes (React Native UI)
  _layout.tsx            # root layout + onboarding guard (disclaimer/name gates)
  index.tsx              # entry redirect resolved from onboarding state
  onboarding/            # welcome → verify → disclaimer → preferred-name → join-circle
  (app)/                 # role-based tabs: anchor, observer, settings (key recovery)
src/
  domain/                # framework-agnostic logic (identity, crypto, recovery,
                         #   disclaimer, preferred-name, roles) — pure TS, unit-tested
  stores/                # Zustand slices (session, membership, policy, dashboard)
                         #   + zustand create() hooks
  platform/              # Expo bindings: Secure_Enclave, platform key store, native keygen
  components/            # small NativeWind primitives
  runtime.ts             # composition root wiring the platform deps
```

## What this shell covers (task 22.1)

- **RSA-2048 keygen into the Secure_Enclave** (R1.4, R1.8): `createIdentity`
  generates the key pair, stores the private key only in `expo-secure-store`
  (Keychain/Keystore), and yields a public-only registration payload for the
  API. The private key is structurally excluded from every API-bound value.
- **Disclaimer acceptance gate before Ambient_Shield** (R26): the disclaimer
  screen records a versioned, timestamped acceptance; `canActivateAmbientShield`
  gates activation, and the onboarding guard blocks progress until accepted.
- **Preferred-name prompt** (R1.7): shown before joining a Circle when no name
  is on file.
- **Key_Recovery** (R23): passphrase-derived (Argon2id, via `@kshema/encryption`)
  encrypted backup synced to the platform cloud key store; restore decrypts
  locally and re-seats the private key without exposing it to the API.
- **Role-based surfaces** (R2.6): Anchor / Observer / Mutual (both) tabs.

## React Native crypto (shared `@kshema/encryption` on Hermes)

The zero-knowledge envelope (AES-256-GCM + RSA-OAEP-SHA256 + gzip) lives once in
the shared `@kshema/encryption` package so the exact same code runs in
`apps/api`, `apps/worker`, and the browser `Web_Crypto_Vault`. It is written
against Node's `crypto`/`zlib` and the `Buffer` global, none of which exist in
React Native's Hermes engine. Rather than fork the crypto into a second, RN-only
implementation (a correctness/audit hazard for a safety product), the mobile app
maps those Node built-ins to native RN equivalents at bundle + runtime:

- `metro.config.js` aliases `crypto`/`node:crypto` → `react-native-quick-crypto`
  (a C/C++ JSI drop-in for Node's `crypto`, real AES-GCM + RSA-OAEP),
  `zlib`/`node:zlib` → a tiny `src/zlib-shim.ts` (pako-backed `gzipSync`/
  `gunzipSync`, the only zlib surface the envelope uses), `buffer` →
  `@craftzdog/react-native-buffer`, and `stream` → `stream-browserify`.
- `src/crypto-polyfill.ts` installs the `Buffer` global and quick-crypto; it is
  the first import in `app/_layout.tsx` so the globals exist before any
  crypto-using module evaluates.

Because `react-native-quick-crypto` is a native module, the app runs in EAS /
dev-client builds (its real distribution model) and **not in Expo Go**.

## Verification split

React Native cannot be typechecked or built without the Expo SDK/native
toolchain, which is not part of the Node/Turborepo CI graph. Verification is
therefore split:

- `pnpm typecheck` (CI) — `tsc -p tsconfig.domain.json`: typechecks the
  framework-agnostic domain + store logic (no RN imports) under Node.
- `pnpm test` (CI) — Vitest over the domain + store unit tests.
- `pnpm typecheck:app` — full RN typecheck via `expo/tsconfig.base`; run in an
  environment with the Expo SDK installed.
- `pnpm build` — production builds run through EAS / `expo`.
```
