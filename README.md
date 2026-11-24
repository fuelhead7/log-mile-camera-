# LogMile Camera

Android app for capturing and tagging roadway inspection photos. The rebuild has its own Android app ID, `com.logmile.camera.rebuild`, so it can be tested alongside the earlier APK. Its logbook starts empty.

## Try it

1. Use Node 24. Run `npm ci` from the repository root.
2. Run `npm start` and scan the QR code with an SDK 58 compatible Expo Go, or install the standalone test APK from the **LogMile Camera Android** GitHub Actions run.
3. Open **Enable camera** and the GPS control. Capture or import a photo, review the tag, and save it to the Logbook. Open the saved record to share the stamped image or original.

## Location and records

- Lookup sends GPS coordinates to the TDOT County Log Network. Pictures and notes are stored on the device and shared when requested.
- County log mile comes from interpolating measures on nearby active TDOT mainline geometry. Interchanges, frontage roads, adjacent routes, and county boundaries can still require manual review. Interstate statewide mileposts and ramp mileage are outside this version.
- The photo review distinguishes TDOT estimates, manual entries, and unverified locations. Imported photos start with blank location fields. GPS simulation is explicitly labeled and cannot save to the logbook.
- Photos are saved in the app's logbook with the original kept separately. The stamped image is generated from the on-screen preview. Existing app data, backups, and projects are outside this version.

## Checks

Run `npm test` for roadway matching tests and `npm run typecheck`. On a physical phone, check camera capture, permission denial, offline manual entry, import, persistence after force stop, and Android sharing. Confirm known TDOT locations before relying on the estimates for inspection records.
