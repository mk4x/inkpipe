# The phone app

Expo SDK 57, Android only. Three screens: pair, capture, queue.

## What it does

**Pair.** Scan the QR the desktop shows. That single exchange is also the key
exchange: the phone generates an Ed25519 identity, sends the public half, and
receives the desktop's X25519 content key. From then on every page is sealed to
that key and to nothing else.

**Capture.** A framing guide, then one tap per page. Pages accumulate into a
session, and a session becomes one note (decision 9). "Done" closes the session
and opens the queue.

**Queue.** Shows every capture with its state, and uploads the pending ones. A
failure on one page does not stop the rest: one oversized or corrupt photograph
must not block a whole lecture.

## The local backup

Originals are kept in **app-private storage**, not the camera roll. Two reasons:
your gallery should not fill with notebook pages, and app-private storage is
removed when the app is uninstalled.

Retention is 90 days or 2 GB, oldest evicted first (decision 15). One rule
overrides both limits:

> **A capture that has not been uploaded is never deleted, at any age, even if
> that means exceeding 2 GB.**

It is the only copy of that page in existence. Evicting it to save space would
silently lose your notes, so a phone full of pending pages is a problem the app
surfaces rather than solves. There is a warning at 80 percent.

This backup is also what makes a lost desktop key survivable until issue #4
(the recovery code) lands.

## Building it

You need a JDK 17 and the Android SDK. Neither needs admin rights: both install
as plain zip extractions.

```bash
# JDK 17
curl -L -o jdk17.zip https://aka.ms/download-jdk/microsoft-jdk-17-windows-x64.zip
# extract to ~/tools/jdk-extracted

# Android command line tools, then:
sdkmanager --sdk_root=<sdk> "platform-tools" "platforms;android-35" "build-tools;35.0.0"
```

Licences must be accepted before `sdkmanager` will install anything. Piping `y`
into it does not work reliably on Windows. Write the hash files directly, which
is what CI images do:

```
<sdk>/licenses/android-sdk-license          24333f8a63b6825ea9c5514f83c2829b004d1fee
                                            8933bad161af4178b1185d1a37fbf41ea5269c55
                                            d56f5187479451eabf01fb78af6dfcb131a6481e
<sdk>/licenses/android-sdk-preview-license  84831b9409646a918e30573bab4c9c91346d8abd
```

Then:

```bash
export JAVA_HOME=~/tools/jdk-extracted/jdk-17.0.20.1+1
export ANDROID_HOME=~/tools/android-sdk

cd apps/phone
npx expo prebuild --platform android --clean
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
cd android && ./gradlew assembleDebug
```

The APK lands in `android/app/build/outputs/apk/debug/`.

A plain debug build bundles all four ABIs and comes out around 190 MB. For a
phone, build one architecture:

```bash
./gradlew assembleDebug -PreactNativeArchitectures=arm64-v8a
```

That is roughly 62 MB. Almost every Android phone from the last several years is
arm64-v8a. Install with `adb install -r <apk>`, or copy it across and open it,
which needs "install unknown apps" enabled for whatever app you open it from.

`android/` and `ios/` are gitignored. Expo regenerates them from `app.json`, so
they are build output rather than source. Never edit them by hand: the next
prebuild discards the changes.

## Monorepo notes

Two things that are easy to get wrong here:

**One Expo version, everywhere.** The phone is on **SDK 57**, which uses React
19, the same major the desktop UI runs. That is deliberate: an earlier attempt
put the phone on SDK 52 while the root had hoisted SDK 57, and the Android build
resolves from the root, so it compiled SDK 57 native modules against an SDK 52
app. The symptom was an opaque Gradle error:

```
Could not get unknown property 'release' for SoftwareComponent container
  at expo-modules-core/android/ExpoModulesCorePlugin.gradle line 95
```

If you ever see that, it is version skew, not a Gradle problem. Check what
`node_modules/expo` resolves to at the **repo root**, not in `apps/phone`.

**A plain reinstall does not fix skew.** Stale hoisted copies survive
`npm install`. Clear them first:

```bash
rm -rf node_modules apps/*/node_modules packages/*/node_modules package-lock.json
npm install
```

**`npx expo install --fix` pins aggressively.** It wanted TypeScript 6, which
would have dragged the whole repo forward as a side effect of a phone
dependency. Check its edits to `apps/phone/package.json` before accepting them.

## Testing

Pure logic is deliberately split out of the Expo-importing modules so it runs
under `node --test` rather than only on a device:

| file | covers |
|---|---|
| `src/retention.ts` | eviction rules, 14 tests |
| `src/pairing.ts` | QR payload validation, 7 tests |

The camera, secure storage and filesystem are not unit tested. They need a
device, and a mock of them would only prove the mock works.

For end-to-end work without a phone, `tools/fake-phone.ts` does exactly what
this app does: reads a pairing payload, completes pairing, seals pages, uploads
a session. Use it to reproduce phone-side behaviour from a terminal.
