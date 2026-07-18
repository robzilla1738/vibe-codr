import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

export function useAccessibilitySettings() {
  const [reduceMotion, setReduceMotion] = useState(false);
  const [reduceTransparency, setReduceTransparency] = useState(false);

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion).catch(() => undefined);
    const transparencyEnabled = AccessibilityInfo.isReduceTransparencyEnabled as undefined | (() => Promise<boolean>);
    if (typeof transparencyEnabled === "function") void transparencyEnabled().then(setReduceTransparency).catch(() => undefined);
    const motion = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    const transparency = typeof transparencyEnabled === "function"
      ? AccessibilityInfo.addEventListener("reduceTransparencyChanged", setReduceTransparency)
      : null;
    return () => { motion.remove(); transparency?.remove(); };
  }, []);

  return { reduceMotion, reduceTransparency };
}
