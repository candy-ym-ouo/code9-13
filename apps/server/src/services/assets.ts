import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {
  azimuthAt,
  elevationAt,
  utcToZonedParts,
  zonedTimeToUtc,
  type AssetRole,
  type PaletteColor,
} from '@flil/shared';
import { config } from '../config.js';
import { getDb, newId, nowIso, parseJson, toJson } from '../db.js';
import { parseExif } from './exif.js';
import { extractPalette } from './paletteExtract.js';
import { emitEvent } from './events.js';
import { logger } from '../logger.js';

export interface AssetRow {
  id: string;
  library_id: string;
  inspiration_id: string;
  role: AssetRole;
  file_path: string;
  thumb_path: string | null;
  mime: string | null;
  width: number;
  height: number;
  bytes: number;
  sha256: string | null;
  shot_at: string | null;
  camera_model: string | null;
  lens: string | null;
  iso: number | null;
  aperture: string | null;
  shutter: string | null;
  has_gps_exif: number;
  palette: string;
  sun_elevation: number | null;
  sun_azimuth: number | null;
  weather_snapshot: string | null;
  created_at: string;
  updated_at: string;
}

function subdir(date = new Date()): string {
  return path.join(String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, '0'));
}

export interface IngestResult {
  assetId: string;
  duplicateOf: string | null;
  hasGpsExif: boolean;
  shotAt: string | null;
  width: number;
  height: number;
}

/**
 * 单张图片入库管线（文档 11.3）：
 * 落盘 → 元数据 → 缩略图 → 主色 → 拍摄时刻太阳位置 → 判重。
 * 注意：EXIF 中的 GPS **默认不落库**，只记录布尔位并提示用户。
 */
export async function ingestAsset(params: {
  libraryId: string;
  inspirationId: string;
  role: AssetRole;
  filename: string;
  buffer: Buffer;
  /** 若已知机位坐标，则用拍摄时刻计算当时太阳位置 */
  spot?: { lat: number; lng: number; tz: string } | null;
}): Promise<IngestResult> {
  const db = getDb();
  const { libraryId, inspirationId, role, buffer, spot } = params;

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const existing = db
    .prepare('SELECT id FROM asset WHERE library_id = ? AND sha256 = ? LIMIT 1')
    .get(libraryId, sha256) as { id: string } | undefined;

  const image = sharp(buffer, { failOn: 'none' });
  const metadata = await image.metadata();
  const exif = parseExif(metadata.exif as Buffer | undefined);

  const dir = path.join(config.uploadDir, libraryId, subdir());
  const thumbDir = path.join(config.thumbDir, libraryId, subdir());
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(thumbDir, { recursive: true });

  const id = newId();
  const ext = metadata.format === 'png' ? 'png' : metadata.format === 'webp' ? 'webp' : 'jpg';
  const filePath = path.join(dir, `${id}.${ext}`);
  const thumbPath = path.join(thumbDir, `${id}.webp`);

  await sharp(buffer, { failOn: 'none' })
    .rotate()
    .toFile(filePath)
    .catch(async () => {
      fs.writeFileSync(filePath, buffer);
    });

  await sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 78 })
    .toFile(thumbPath)
    .catch(() => undefined);

  let palette: PaletteColor[] = [];
  try {
    palette = await extractPalette(filePath);
  } catch (err) {
    logger.warn('palette 提取失败', { assetId: id, error: String(err) });
  }

  let sunElevation: number | null = null;
  let sunAzimuth: number | null = null;
  if (exif.shotAt && spot) {
    const asUtc = exif.shotAt; // EXIF 是"相机本地时间"
    const parts = utcToZonedParts(asUtc, 'UTC');
    const instant = zonedTimeToUtc(spot.tz, parts.year, parts.month, parts.day, parts.hour, parts.minute);
    sunElevation = elevationAt(instant, spot.lat, spot.lng);
    sunAzimuth = azimuthAt(instant, spot.lat, spot.lng);
  }

  const ts = nowIso();
  db.prepare(
    `INSERT INTO asset (id, library_id, inspiration_id, role, file_path, thumb_path, mime, width, height, bytes,
       sha256, shot_at, camera_model, lens, iso, aperture, shutter, has_gps_exif, palette,
       sun_elevation, sun_azimuth, weather_snapshot, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    libraryId,
    inspirationId,
    role,
    filePath,
    thumbPath,
    metadata.format ? `image/${metadata.format}` : 'image/jpeg',
    metadata.width ?? 0,
    metadata.height ?? 0,
    buffer.byteLength,
    sha256,
    exif.shotAt ? exif.shotAt.toISOString() : null,
    exif.cameraModel,
    exif.lens,
    exif.iso,
    exif.aperture,
    exif.shutter,
    exif.hasGps ? 1 : 0,
    toJson(palette),
    sunElevation,
    sunAzimuth,
    null,
    ts,
    ts,
  );

  emitEvent(
    {
      type: 'asset_processed',
      libraryId,
      payload: { assetId: id, inspirationId, width: metadata.width ?? 0, height: metadata.height ?? 0 },
    },
    // 以素材 id 为幂等键：管线重试/补处理不会让同一张素材的"处理完成"事件重复下发。
    `asset:${id}`,
  );

  return {
    assetId: id,
    duplicateOf: existing?.id ?? null,
    hasGpsExif: exif.hasGps,
    shotAt: exif.shotAt ? exif.shotAt.toISOString() : null,
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
  };
}

export function assetAbsolutePath(row: AssetRow, kind: 'file' | 'thumb'): string | null {
  const p = kind === 'file' ? row.file_path : row.thumb_path;
  if (!p) return null;
  return p;
}

export function paletteOf(row: AssetRow): PaletteColor[] {
  return parseJson<PaletteColor[]>(row.palette, []);
}

/** 分享图：另存一份并剥离全部 EXIF（文档 11.3 / 13.4） */
export async function shareImageFor(row: AssetRow, libraryId: string): Promise<string> {
  const target = path.join(config.shareDir, libraryId, `${row.id}.jpg`);
  if (fs.existsSync(target)) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await sharp(row.file_path, { failOn: 'none' })
    .rotate()
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toFile(target);
  return target;
}

export function deleteAssetFiles(row: AssetRow): void {
  for (const p of [row.file_path, row.thumb_path]) {
    if (!p) continue;
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* 忽略文件删除失败 */
    }
  }
}
