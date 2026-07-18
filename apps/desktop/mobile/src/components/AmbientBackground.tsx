// Opaque workspace canvas. Desktop keeps the shell quiet and lets content and
// chrome carry hierarchy; mobile follows the same rule instead of painting a
// decorative brand gradient behind every session.
import { StyleSheet, View } from "react-native";
import { useTheme } from "../theme/ThemeProvider";

export function AmbientBackground() {
  const { colors } = useTheme();
  return <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }]} />;
}
