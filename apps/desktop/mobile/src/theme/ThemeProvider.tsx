import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { getTheme, isKnownTheme, type Palette } from "@shared/themes";
import { buildColorTokens, type ColorTokens, type Theme } from "./tokens";

interface ThemeContextValue {
  theme: Theme;
  palette: Palette;
  colors: ColorTokens;
  setThemeName: (name: string) => void;
  setAccent: (hex: string | undefined) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children, initialTheme = "default", initialAccent }: {
  children: ReactNode;
  initialTheme?: string;
  initialAccent?: string;
}) {
  const [name, setName] = useState(initialTheme);
  const [accent, setAccent] = useState<string | undefined>(initialAccent);
  const value = useMemo<ThemeContextValue>(() => {
    const palette = getTheme(isKnownTheme(name) ? name : "default");
    const colors = buildColorTokens(palette, accent, name);
    return { theme: { name, colors, accentOverride: accent }, palette, colors, setThemeName: setName, setAccent };
  }, [name, accent]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
