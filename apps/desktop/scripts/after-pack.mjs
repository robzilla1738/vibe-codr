import { execFileSync } from "node:child_process";
import { join } from "node:path";

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const plist = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Info.plist");
  const buddy = "/usr/libexec/PlistBuddy";
  for (const key of [
    "NSBluetoothAlwaysUsageDescription",
    "NSBluetoothPeripheralUsageDescription",
    "NSCameraUsageDescription",
    "NSMicrophoneUsageDescription",
  ]) {
    try {
      execFileSync(buddy, ["-c", `Delete :${key}`, plist], { stdio: "ignore" });
    } catch {
      // Electron versions differ in which unused permission strings they add.
    }
  }
  execFileSync(buddy, ["-c", "Set :NSAppTransportSecurity:NSAllowsArbitraryLoads false", plist]);
  try {
    execFileSync(buddy, ["-c", "Delete :NSAppTransportSecurity:NSExceptionDomains", plist], { stdio: "ignore" });
  } catch {
    // Some Electron distributions do not add localhost ATS exceptions.
  }
}
