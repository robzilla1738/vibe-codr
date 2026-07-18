import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useTheme } from "../theme/ThemeProvider";

const iconSource = require("../../assets/icon.png");
const wordmarkSource = require("../../assets/vibe-codr-wordmark.png");

export function BrandIcon({ size = 56, style }: { size?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.iconFrame, { width: size, height: size, borderRadius: size * 0.235 }, style]}>
      <Image
        source={iconSource}
        resizeMode="contain"
        accessibilityLabel="Vibe Codr"
        style={{ width: size, height: size }}
      />
    </View>
  );
}

// Use the real distressed desktop wordmark. Tinting its alpha mask keeps it
// legible in every app theme without inventing a second mobile brand treatment.
export function BrandWordmark({ variant = "topbar" }: { variant?: "topbar" | "splash" }) {
  const { colors } = useTheme();
  const width = variant === "splash" ? 176 : 92;
  const height = variant === "splash" ? 42 : 24;
  return (
    <View style={{ width, height, overflow: "hidden" }} accessibilityLabel="Vibe Codr">
      <Image
        source={wordmarkSource}
        resizeMode="contain"
        style={[
          styles.wordmark,
          {
            width,
            height: width * 0.4,
            top: -(width * 0.4 - height) / 2,
            tintColor: colors.assistant,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  iconFrame: { overflow: "hidden" },
  wordmark: { position: "absolute", left: 0 },
});
