import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { File } from "expo-file-system";
import { formatAtPath } from "@shared/file-fuzzy";
import { MOBILE_UPLOAD_MAX_BYTES } from "../../../relay/protocol";
import type { RemoteEngineClient } from "../remote/RemoteEngineClient";
import { MOBILE_COMPOSER_MAX_ATTACHMENTS, type MobileComposerAttachment } from "./attachment-commands";
import { uploadBatch } from "./upload-batch";

interface PickedAsset {
  uri: string;
  name: string;
  size?: number;
  mimeType?: string;
}

export interface MobileAttachmentUploadOutcome {
  attachments: MobileComposerAttachment[];
  errors: string[];
}

export async function pickAndUploadMobileAttachments(
  kind: "photo" | "file",
  client: RemoteEngineClient,
  cwd: string,
  limit: number,
): Promise<MobileAttachmentUploadOutcome> {
  if (limit <= 0) throw new Error(`You can attach up to ${MOBILE_COMPOSER_MAX_ATTACHMENTS} files at a time.`);
  const picked = (kind === "photo" ? await pickPhotos(limit) : await pickDocuments())
    .slice(0, limit);
  const outcome = await uploadBatch(picked, async (asset): Promise<MobileComposerAttachment> => {
    if (asset.size !== undefined && asset.size > MOBILE_UPLOAD_MAX_BYTES) {
      throw new Error(`${asset.name} is larger than the ${MOBILE_UPLOAD_MAX_BYTES / 1024 / 1024}MB attachment limit.`);
    }
    const file = new File(asset.uri);
    if (!file.exists) throw new Error(`${asset.name} is no longer available on this device.`);
    if (file.size > MOBILE_UPLOAD_MAX_BYTES) {
      throw new Error(`${asset.name} is larger than the ${MOBILE_UPLOAD_MAX_BYTES / 1024 / 1024}MB attachment limit.`);
    }
    const dataBase64 = await file.base64();
    const result = await client.uploadFile({ cwd, name: asset.name, ...(asset.mimeType ? { mimeType: asset.mimeType } : {}), dataBase64 });
    if (!result.ok) throw new Error(result.error);
    return {
      id: result.path,
      name: result.name,
      path: result.path,
      token: formatAtPath(result.path),
      size: result.size,
      ...(result.mimeType ? { mimeType: result.mimeType } : {}),
    };
  }, (asset) => `${asset.name} could not be uploaded.`);
  return { attachments: outcome.uploaded, errors: outcome.errors };
}

async function pickPhotos(limit: number): Promise<PickedAsset[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: limit > 1,
    selectionLimit: limit,
    quality: 1,
  });
  if (result.canceled) return [];
  return result.assets.map((asset, index) => ({
    uri: asset.uri,
    name: asset.fileName?.trim() || `mobile-photo-${index + 1}.jpg`,
    ...(asset.fileSize !== undefined ? { size: asset.fileSize } : {}),
    ...(asset.mimeType ? { mimeType: asset.mimeType } : { mimeType: "image/jpeg" }),
  }));
}

async function pickDocuments(): Promise<PickedAsset[]> {
  const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true, type: "*/*" });
  if (result.canceled) return [];
  return result.assets.map((asset) => ({
    uri: asset.uri,
    name: asset.name,
    ...(asset.size !== undefined ? { size: asset.size } : {}),
    ...(asset.mimeType ? { mimeType: asset.mimeType } : {}),
  }));
}
