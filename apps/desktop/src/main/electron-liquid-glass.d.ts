declare module "electron-liquid-glass" {
  interface GlassOptions {
    cornerRadius?: number;
    tintColor?: string;
  }

  interface LiquidGlassApi {
    readonly GlassMaterialVariant: {
      readonly sidebar: number;
    };
    isGlassSupported(): boolean;
    addView(nativeWindowHandle: Buffer, options?: GlassOptions): number;
    unstable_setVariant(viewId: number, variant: number): void;
  }

  const liquidGlass: LiquidGlassApi;
  export default liquidGlass;
}
