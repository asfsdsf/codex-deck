import { KeyTree, crypto } from "privacy-kit";
import { getServerEncryptionSecret } from "./serverSecrets";

let keyTree: KeyTree | null = null;

export async function initEncrypt() {
  const serverEncryptionSecret = await getServerEncryptionSecret();
  keyTree = new KeyTree(
    await crypto.deriveSecureKey({
      key: serverEncryptionSecret,
      usage: "codexdeck-server-tokens",
    }),
  );
}

export function encryptString(path: string[], string: string) {
  return keyTree!.symmetricEncrypt(path, string);
}

export function encryptBytes(path: string[], bytes: Uint8Array<ArrayBuffer>) {
  return keyTree!.symmetricEncrypt(path, bytes);
}

export function decryptString(
  path: string[],
  encrypted: Uint8Array<ArrayBuffer>,
) {
  return keyTree!.symmetricDecryptString(path, encrypted);
}

export function decryptBytes(
  path: string[],
  encrypted: Uint8Array<ArrayBuffer>,
) {
  return keyTree!.symmetricDecryptBuffer(path, encrypted);
}
