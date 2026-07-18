import type { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "Vibe Codr",
  description:
    "A secure companion for controlling your Vibe Codr sessions from iPhone, iPad, and Android.",
  slug: "vbcode-mobile",
  scheme: "vibecodr",
  version: "0.1.0",
  icon: "./assets/icon.png",
  backgroundColor: "#0b0b0b",
  primaryColor: "#0b0b0b",
  orientation: "default",
  userInterfaceStyle: "automatic",
  newArchEnabled: true,
  ios: {
    bundleIdentifier: "com.vibecodr.mobile",
    supportsTablet: true,
    config: {
      usesNonExemptEncryption: false,
    },
    infoPlist: {
      NSLocalNetworkUsageDescription:
        "Vibe Codr discovers and controls your local engine over the network.",
    },
  },
  android: {
    package: "com.vibecodr.mobile",
    backgroundColor: "#0b0b0b",
    adaptiveIcon: {
      foregroundImage: "./assets/vibe-codr-mark.png",
      monochromeImage: "./assets/vibe-codr-mark.png",
      backgroundColor: "#080808",
    },
  },
  web: { bundler: "metro", output: "single", favicon: "./assets/icon.png" },
  plugins: [
    "expo-secure-store",
    "expo-status-bar",
    "expo-system-ui",
    "expo-document-picker",
    [
      "expo-image-picker",
      {
        photosPermission: "Vibe Codr accesses selected photos so you can attach them to your desktop session.",
        cameraPermission: false,
        microphonePermission: false,
      },
    ],
    [
      "expo-splash-screen",
      {
        image: "./assets/icon.png",
        imageWidth: 168,
        backgroundColor: "#f3f3f1",
        dark: {
          image: "./assets/icon.png",
          backgroundColor: "#080808",
        },
      },
    ],
    [
      "expo-build-properties",
      {
        android: {
          // The desktop companion advertises a local ws:// relay by default.
          // Remote/non-LAN pairings remain explicitly restricted to wss:// in-app.
          usesCleartextTraffic: true,
        },
      },
    ],
  ],
};

export default config;
