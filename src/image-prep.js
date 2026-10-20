// 图片预处理：把 QQ 图片统一转成视觉接口能接受的 JPEG。
//
// 背景：QQ 里经常出现超长截图（例如 1027×15000），部分视觉网关会限制单边
// 8000 像素，超过后整条模型请求会被判成 "unsupported image"。这里做两件事：
//   1. 普通图片按最长边等比缩小，并重新编码为 JPEG（同时清掉 EXIF/CMYK）；
//   2. 超长截图从上到下切段，相邻段保留少量重叠，避免文字被切断。
// 输出统一为 data:image/jpeg;base64,...，调用方不需要再关心格式。

import sharp from 'sharp';

export const IMAGE_PREP_DEFAULTS = Object.freeze({
  maxSide: 2048,
  splitAbove: 4096,
  maxSegments: 6,
  overlap: 64,
  quality: 85
});

const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif']);

function sizeLabel(width, height) {
  return `${width}×${height}`;
}

/**
 * 把图片缓冲预处理成 1 张或多张 data URL。
 *
 * @param {Buffer} buffer 原始图片字节
 * @param {object} [options]
 * @param {boolean} [options.split] 是否允许切分超长截图，默认 true
 * @param {number} [options.maxSide] 输出图片最长边，默认 2048
 * @param {number} [options.splitAbove] 高度超过该值时切段，默认 4096
 * @param {number} [options.maxSegments] 单张图最多切几段，默认 6
 * @param {number} [options.overlap] 相邻段的像素重叠，默认 64
 * @param {number} [options.quality] JPEG 质量，默认 85
 * @returns {Promise<{dataUrls: string[], segments: number, note: string, width: number, height: number, format: string}>}
 */
export async function prepareImageDataUrls(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('图片内容为空');
  }
  const cfg = { ...IMAGE_PREP_DEFAULTS, ...options };

  let meta;
  try {
    meta = await sharp(buffer, { animated: false, failOn: 'none' }).metadata();
  } catch (error) {
    throw new Error(`图片无法解析：${error?.message ?? error}`);
  }
  if (!meta?.width || !meta?.height) throw new Error('图片尺寸无效');
  const format = String(meta.format || '').toLowerCase();
  if (!ALLOWED_FORMATS.has(format)) {
    throw new Error(`图片格式不支持：${format || '未知'}`);
  }

  const orientation = Number(meta.orientation) || 1;
  const sideways = orientation >= 5 && orientation <= 8;
  const width = sideways ? meta.height : meta.width;
  const height = sideways ? meta.width : meta.height;

  // 带 90° 旋转的图片不切段，避免切完再旋转导致阅读顺序错乱，只做整体缩放。
  const canSplit = cfg.split !== false && orientation === 1 && height > cfg.splitAbove;
  const segments = canSplit
    ? Math.min(cfg.maxSegments, Math.max(2, Math.ceil(height / cfg.splitAbove)))
    : 1;

  const encode = (pipeline) => pipeline
    .rotate()
    .resize({
      width: cfg.maxSide,
      height: cfg.maxSide,
      fit: 'inside',
      withoutEnlargement: true
    })
    .flatten({ background: '#ffffff' })
    .toColourspace('srgb')
    .jpeg({ quality: cfg.quality, mozjpeg: true })
    .toBuffer();

  const buffers = [];
  if (segments === 1) {
    buffers.push(await encode(sharp(buffer, { animated: false, failOn: 'none' })));
  } else {
    for (let index = 0; index < segments; index += 1) {
      const rawTop = Math.round((index * meta.height) / segments);
      const rawBottom = Math.round(((index + 1) * meta.height) / segments);
      const top = Math.max(0, rawTop - (index > 0 ? cfg.overlap : 0));
      const bottom = Math.min(meta.height, rawBottom + (index < segments - 1 ? cfg.overlap : 0));
      const pipeline = sharp(buffer, { animated: false, failOn: 'none' })
        .extract({ left: 0, top, width: meta.width, height: bottom - top });
      buffers.push(await encode(pipeline));
    }
  }

  return {
    dataUrls: buffers.map((item) => `data:image/jpeg;base64,${item.toString('base64')}`),
    segments,
    note: segments > 1
      ? `原图 ${sizeLabel(width, height)}，已从上到下切成 ${segments} 段（相邻段有少量重叠）`
      : `原图 ${sizeLabel(width, height)}`,
    width,
    height,
    format
  };
}
