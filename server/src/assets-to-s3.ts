import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { putObject, usesS3 } from "../../agents/generator/src/assets.js";
import { DATA_DIR } from "./paths.js";

/**
 * One-shot: upload the local ./data tree (refs/** + outputs/**) into the S3 bucket
 * (Supabase Storage / R2 / MinIO). Idempotent — objects are simply overwritten.
 *
 *   S3_ENDPOINT=… S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… S3_BUCKET=sweatshop \
 *     npm run assets-to-s3
 */
async function walk(dir: string): Promise<string[]> {
  let out: string[] = [];
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out = out.concat(await walk(p));
    else if (/\.(png|jpe?g|webp|gif)$/i.test(e)) out.push(p);
  }
  return out;
}

async function main() {
  if (!usesS3()) throw new Error("S3_ENDPOINT (+ keys + S3_BUCKET) must be set — see .env.example");
  let n = 0;
  for (const top of ["refs", "outputs"]) {
    for (const file of await walk(join(DATA_DIR, top))) {
      const key = relative(DATA_DIR, file).split("\\").join("/");
      await putObject(key, readFileSync(file));
      n++;
      if (n % 25 === 0) console.log(`… ${n} uploaded`);
    }
  }
  console.log(`✔ ${n} asset(s) uploaded to ${process.env.S3_BUCKET || "sweatshop"} from ${DATA_DIR}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
