# Local Android build (verified Windows recipe)

The Kshema mobile app uses a native module (react-native-quick-crypto), so it
cannot run in Expo Go. It needs a build that compiles native code. This document
captures the exact, validated steps for building and running the Android app
locally on Windows (including a locked-down, no-admin setup).

> The app does NOT use expo-dev-client. It was removed because the dev
> launcher/menu auto-opened its own activity over the UI. A plain debug build
> boots straight into the app and loads JS from Metro; a release build embeds
> the JS and needs no Metro at all.

For the cloud alternative (EAS Build) and general notes, see README.md.

## Why the native project is not in git

The generated android/ (and ios/) directories are gitignored and are recreated
by `expo prebuild`. After a fresh clone they do not exist yet - the prebuild step
regenerates them. This keeps build caches and generated files out of the repo.

## Prerequisites (all installable without admin)

- Node 20+ and pnpm 11 (root package.json pins the pnpm version).
- Android Studio with, via SDK Manager -> SDK Tools: SDK Platform android-34,
  CMake 3.22.1, NDK 26.x.
- JDK 17. Gradle 8.8 / RN 0.74 do NOT run on JDK 21+. Use a standalone Temurin 17
  (a portable unzip is fine, e.g. C:\Projects\OpenJDK17U-...\jdk-17.0.x).
- A short project path. The C++ object paths (quick-crypto + OpenSSL) exceed the
  Windows path limit under deep folders (e.g. OneDrive) and CMake fails with
  CMAKE_OBJECT_PATH_MAX. Keep the repo near the drive root, e.g. C:\Projects\Kshema.

## Build steps (from repo root, then apps/mobile)

    pnpm install
    cd apps/mobile
    pnpm prebuild --platform android --clean
    # recreate android/local.properties with your SDK path (escaped backslashes):
    #   sdk.dir=C:\\Users\\<you>\\AppData\\Local\\Android\\Sdk
    cd android
    $env:JAVA_HOME="C:\Projects\OpenJDK17U-...\jdk-17.0.x"
    $env:ANDROID_HOME="$env:LOCALAPPDATA\Android\Sdk"
    $env:NODE_ENV="development"
    $env:PATH="$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"
    .\gradlew.bat :app:assembleDebug --no-daemon
    # Debug APK:   android/app/build/outputs/apk/debug/app-debug.apk
    # Release APK (JS embedded, no Metro): .\gradlew.bat :app:assembleRelease --no-daemon

## Emulator setup (important on newer system images)

1. Use software GPU rendering. On very new API levels the hardware GL path
   renders every React Native surface PURE BLACK. Fix it once in the AVD config
   (%USERPROFILE%\.android\avd\<AVD>.avd\config.ini):

       hw.gpu.mode=swiftshader_indirect

   or launch with: emulator -avd <AVD> -gpu swiftshader_indirect

2. The "Android App Compatibility / 16 KB" dialog. On Android 15+/newer images a
   system dialog appears on first launch ("This app isn't 16 KB compatible ...
   will be run using page size compatible mode"). RN 0.74 native .so libs are not
   16 KB-page aligned. It is ONLY a warning - tap "Don't Show Again" and the app
   runs normally underneath. A stable API 34 emulator avoids both issues.

## Install and run

    $adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
    & $adb install -r app\build\outputs\apk\debug\app-debug.apk
    # Start Metro from apps/mobile (plain start, no dev client): pnpm start
    & $adb reverse tcp:8081 tcp:8081
    # Launch directly (no dev-client deep link):
    & $adb shell monkey -p in.kshema.app -c android.intent.category.LAUNCHER 1

The app loads the JS bundle from Metro and mounts MainActivity, then shows the
onboarding welcome screen. JS-only edits just need a reload; native dep changes
require a rebuild.

### Verify from the terminal (no screenshots)

    & $adb shell dumpsys activity activities | Select-String "ResumedActivity" | Select-Object -First 1
    & $adb logcat -d | Select-String "ReactNativeJS"   # expect: Running "main" with {"rootTag":...}
    & $adb shell uiautomator dump /sdcard/ui.xml; & $adb pull /sdcard/ui.xml

## Native-module note (important)

The app builds on the OLD React Native architecture (newArchEnabled=false in the
generated android/gradle.properties), which react-native-quick-crypto 0.7.x targets.

@craftzdog/react-native-buffer depends on react-native-quick-base64@^3, but 3.x is
new-architecture-only (ships codegen specs, no old-arch android/build.gradle), so
autolinking silently skips it under RN 0.74 - surfacing at runtime as:

    Invariant Violation: TurboModuleRegistry.getEnforcing(...): QuickBase64 could not be found.

pnpm-workspace.yaml therefore pins react-native-quick-base64 to 2.2.2 (the last
old-arch release that ships android/build.gradle) so it autolinks and the native
crypto stack loads. Keep that override while the app stays on the old architecture.
