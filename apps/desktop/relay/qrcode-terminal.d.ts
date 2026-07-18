declare module "qrcode-terminal" {
  export function generate(
    input: string,
    opts?: { small?: boolean },
    callback?: (qr: string) => void,
  ): void;
}
