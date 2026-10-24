import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { guard } from "../auth.js";
import { pool } from "../db.js";
import { badRequest, conflict } from "../errors.js";

export async function registerProfileRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/profile/avatar", { preHandler: guard({ csrf: true }) }, async (request) => {
    const auth = request.auth!;
    if (!auth.stockId) throw conflict("Your account has no Aura stock");
    const upload = await request.file();
    if (!upload || !upload.mimetype.startsWith("image/")) throw badRequest("Upload a PNG, JPEG, or WebP image", "INVALID_IMAGE");
    const source = await upload.toBuffer();
    let output: Buffer;
    try {
      output = await sharp(source, { failOn: "error", limitInputPixels: 25_000_000 })
        .rotate().resize(512, 512, { fit: "cover", position: "attention" }).webp({ quality: 82 }).toBuffer();
    } catch {
      throw badRequest("The uploaded image could not be processed", "INVALID_IMAGE");
    }
    const directory = path.resolve("uploads");
    await mkdir(directory, { recursive: true });
    const filename = `${auth.stockId}.webp`;
    await writeFile(path.join(directory, filename), output);
    const publicPath = `/uploads/${filename}`;
    await pool.query("UPDATE listings SET avatar_path=$1,updated_at=now() WHERE id=$2", [publicPath, auth.stockId]);
    await pool.query(
      "INSERT INTO audit_logs(actor_id,action,entity_type,entity_id) VALUES ($1,'AVATAR_UPDATED','PERSON_STOCK',$2)",
      [auth.id, auth.stockId]
    );
    return { avatarPath: publicPath };
  });
}

