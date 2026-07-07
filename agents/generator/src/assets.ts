import { readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join, basename } from "path";
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { DATA_DIR } from "./paths";

/**
 * Binary assets (reference images + generated slides), dual backend:
 *   fs (default):      DATA_DIR/refs/<influencer>/…  DATA_DIR/outputs/<concept>/<influencer>/…
 *   s3 (S3_ENDPOINT set): same layout as object keys in $S3_BUCKET — Supabase
 *   Storage's S3-compatible endpoint, or any S3 store (R2/AWS/MinIO).
 * With s3 the app container is stateless: no volume needed anywhere.
 */
export type AssetFile = { name: string; data: Buffer };

export const usesS3 = (): boolean => !!process.env.S3_ENDPOINT;

let client: S3Client | null = null;
function s3(): S3Client {
  if (!client) {
    client = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION || "us-east-1",
      forcePathStyle: true, // Supabase Storage + MinIO are path-style
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
      },
    });
  }
  return client;
}
const BUCKET = () => process.env.S3_BUCKET || "sweatshop";

const IMG_RE = /\.(png|jpe?g|webp|gif)$/i;
export const mimeFor = (name: string): string => {
  const ext = (name.split(".").pop() || "png").toLowerCase();
  return ext === "jpg" ? "image/jpeg" : `image/${ext}`;
};

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  return Buffer.from(await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray());
}

/** All objects under a prefix, sorted by name. */
async function s3List(prefix: string): Promise<AssetFile[]> {
  const listed = await s3().send(new ListObjectsV2Command({ Bucket: BUCKET(), Prefix: prefix }));
  const keys = (listed.Contents ?? [])
    .map((o) => o.Key!)
    .filter((k) => IMG_RE.test(k))
    .sort();
  const out: AssetFile[] = [];
  for (const key of keys) {
    const obj = await s3().send(new GetObjectCommand({ Bucket: BUCKET(), Key: key }));
    out.push({ name: basename(key), data: await bodyToBuffer(obj.Body) });
  }
  return out;
}

export async function putObject(key: string, data: Buffer, contentType?: string): Promise<void> {
  await s3().send(new PutObjectCommand({ Bucket: BUCKET(), Key: key, Body: data, ContentType: contentType || mimeFor(key) }));
}

function fsList(dir: string): AssetFile[] {
  try {
    return readdirSync(dir)
      .filter((f) => IMG_RE.test(f))
      .sort()
      .map((f) => ({ name: f, data: readFileSync(join(dir, f)) }));
  } catch {
    return [];
  }
}

// ---- reference images (per influencer) ----------------------------------------
const refKey = (influencerId: string, name: string) => `refs/${influencerId}/${basename(name)}`;
const refDir = (influencerId: string) => join(DATA_DIR, "refs", influencerId);

export async function listRefs(influencerId: string): Promise<AssetFile[]> {
  if (usesS3()) return s3List(`refs/${influencerId}/`);
  return fsList(refDir(influencerId));
}

export async function addRef(influencerId: string, name: string, data: Buffer): Promise<void> {
  if (usesS3()) { await putObject(refKey(influencerId, name), data); return; }
  mkdirSync(refDir(influencerId), { recursive: true });
  writeFileSync(join(refDir(influencerId), basename(name)), data);
}

export async function removeRef(influencerId: string, name: string): Promise<void> {
  if (usesS3()) { await s3().send(new DeleteObjectCommand({ Bucket: BUCKET(), Key: refKey(influencerId, name) })); return; }
  try { unlinkSync(join(refDir(influencerId), basename(name))); } catch { /* gone */ }
}

// ---- generated slides (per concept + influencer) --------------------------------
const slideKey = (conceptId: string, influencerId: string, n: number) => `outputs/${conceptId}/${influencerId}/slide-${n}.png`;
const slideDir = (conceptId: string, influencerId: string) => join(DATA_DIR, "outputs", conceptId, influencerId);

/** Save one rendered slide; returns its key/path (for logs + ticket text). */
export async function putSlide(conceptId: string, influencerId: string, n: number, data: Buffer): Promise<string> {
  if (usesS3()) {
    const key = slideKey(conceptId, influencerId, n);
    await putObject(key, data, "image/png");
    return key;
  }
  const dir = slideDir(conceptId, influencerId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `slide-${n}.png`);
  writeFileSync(path, data);
  return path;
}

export async function listSlides(conceptId: string, influencerId: string): Promise<AssetFile[]> {
  if (usesS3()) return s3List(`outputs/${conceptId}/${influencerId}/`);
  const files = fsList(slideDir(conceptId, influencerId));
  // legacy flat layout (pre-fan-out posts)
  return files.length ? files : fsList(join(DATA_DIR, "outputs", conceptId));
}
