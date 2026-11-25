// 运行期表情库管理：同步 QQ 收藏表情 + 本地认知层（备注/笔记/使用计数）。
// 纯函数在 stickers.js；这里管缓存、TTL 和 OneBot 交互。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { OneBotClient } from './onebot.js';
import { DATA_DIR, getConfig } from './config.js';
import { validateImageUrl, safeFetchBinary } from './safe-fetch.js';
import {
  loadStickerStore, saveStickerStore, mergeStickerLibrary,
  findSticker, formatStickerList, applyStickerNote, markStickerUsed,
  normalizeStickerEntry
} from './stickers.js';

const STICKER_ASSET_DIR = path.join(DATA_DIR, 'sticker-assets');
const MAX_STICKER_BYTES = 8 * 1024 * 1024;
const IMAGE_EXTENSIONS = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
});

function imageType(buffer) {
  if (
    buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  ) return 'image/png';
  if (
    buffer.length >= 3
    && buffer[0] === 0xFF
    && buffer[1] === 0xD8
    && buffer[2] === 0xFF
  ) return 'image/jpeg';
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'))) {
    return 'image/gif';
  }
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'image/webp';
  return '';
}

function cleanMetadata(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export class StickerManager {
  constructor(onebot) {
    this.onebot = onebot;
    this.storageError = null;
    try {
      this.entries = loadStickerStore(undefined, { strict: true });
    } catch (error) {
      this.entries = [];
      this.storageError = error;
    }
    this.syncedAt = 0;
    this.syncing = null;
    this.collectTimes = [];
  }

  get enabled() {
    return getConfig().sticker?.enabled !== false;
  }

  assertStorageWritable() {
    try {
      loadStickerStore(undefined, { strict: true });
      this.storageError = null;
    } catch (error) {
      this.storageError = error;
      throw error;
    }
  }

  saveEntries(entries) {
    this.assertStorageWritable();
    saveStickerStore(entries);
    this.entries = entries;
  }

  /** 同步 QQ 收藏表情（带 TTL 缓存；force 立即刷新）。失败时退回本地缓存。 */
  async sync(force = false) {
    if (!this.enabled) return { entries: this.entries, fromCache: true, disabled: true };
    try {
      this.assertStorageWritable();
    } catch (error) {
      return {
        entries: this.entries,
        fromCache: true,
        error: String(error?.message ?? error)
      };
    }
    const ttl = 60000;
    const now = Date.now();
    if (!force && this.syncedAt && now - this.syncedAt < ttl) {
      return { entries: this.entries, fromCache: true };
    }
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      try {
        const count = Math.min(500, Math.max(1, Number(getConfig().sticker?.promptMaxStickers) * 10 || 100));
        const data = await this.onebot.call('fetch_custom_face_detail', { count });
        const fetched = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : null);
        if (!fetched) throw new Error('fetch_custom_face_detail 返回 data 不是数组');
        // 只有拿到合法数组才合并，避免异常响应清空本地库
        const nextEntries = mergeStickerLibrary(this.entries, fetched);
        this.saveEntries(nextEntries);
        this.syncedAt = Date.now();
        return { entries: this.entries, fromCache: false };
      } catch (error) {
        // 同步失败不致命：本地缓存继续用
        return { entries: this.entries, fromCache: true, error: String(error?.message ?? error) };
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  async list(query = '', limit = 48, force = false) {
    const synced = await this.sync(force);
    return formatStickerList(synced.entries, query, limit);
  }

  /** 只读查看当前本地快照，不触发 QQ 同步或刷新临时 URL。 */
  peek(ref) {
    return findSticker(this.entries, ref);
  }

  async find(ref) {
    const synced = await this.sync(false);
    return findSticker(synced.entries, ref);
  }

  /**
   * 解析一个"可以直接发给 OneBot"的表情。
   *
   * QQ 消息图片地址带短期 rkey，存下来的 URL 过一段时间必然失效（HTTP 400
   * download url has expired）。所以这里按可用性排序逐级降级：
   *   1. 已有本地文件 → base64://，永久可用，不碰网络；
   *   2. 按原消息 get_msg 拿新签名（原消息还在时最省流量）；
   *   3. 把字节抓下来落盘，之后再也不用管签名；
   *   4. 全都拿不到 → 标记该表情失效并返回 null，避免把坏 URL 交给 NapCat
   *      换来一条看不懂的 "下载文件失败: Bad Request"。
   *
   * 返回 null 表示"这个表情现在发不出去"，调用方应提示模型换一个。
   */
  async findForSend(ref, { signal } = {}) {
    const sticker = await this.find(ref);
    if (!sticker) return null;
    if (sticker.localFile) {
      const image = this.readImage(sticker.id);
      if (image) {
        return { ...sticker, url: `base64://${image.buffer.toString('base64')}` };
      }
      // 本地文件丢了但不是失效态：继续往下试远端地址。
    }
    // 已知失效的条目不再浪费一次网络往返。
    if (sticker.imageUnavailableAt) return null;

    let candidate = sticker;
    let refreshed = false;
    const messageId = /^collected_(-?\d+)$/.exec(String(sticker.id))?.[1];
    if (sticker.source === 'ai' && messageId) {
      try {
        const data = await this.onebot.getMsg(Number(messageId));
        const segments = Array.isArray(data?.message) ? data.message : [];
        const image = segments.find((segment) => segment?.type === 'image');
        const freshUrl = String(image?.data?.url || image?.data?.file || '').trim();
        if (/^https?:\/\//i.test(freshUrl) && freshUrl !== sticker.url) {
          candidate = { ...sticker, url: freshUrl };
          refreshed = true;
        }
      } catch {
        // 原消息通常早就没了（NapCat 返回"消息不存在"），继续走本地化兜底。
      }
    }

    if (refreshed) {
      // 换到新签名后先落库：即便这次抓取失败，下次也不必再问一遍 get_msg。
      try {
        this.saveEntries(
          this.entries.map((entry) => (entry.id === sticker.id
            ? normalizeStickerEntry({ ...candidate, updatedAt: new Date().toISOString() })
            : entry))
        );
      } catch {
        // 落库失败不影响本次发送。
      }
    }

    const localized = await this.#localizeRemote(sticker.id, candidate.url, signal);
    if (localized.ok) {
      const pinned = normalizeStickerEntry({
        ...candidate,
        localFile: localized.localFile,
        imageUnavailableAt: 0,
        imageUnavailableReason: '',
        updatedAt: new Date().toISOString()
      });
      try {
        this.saveEntries(
          this.entries.map((entry) => (entry.id === sticker.id ? pinned : entry))
        );
      } catch {
        // 存不下也不影响本次发送：用附件 buffer 直接发。
      }
      const image = this.readImage(sticker.id);
      if (image) return { ...pinned, url: `base64://${image.buffer.toString('base64')}` };
    }

    if (refreshed) {
      // 拿到过新签名却没抓下来，更像网络抖动而不是地址过期：
      // 交回候选 URL，保持原来"让 OneBot 试一次"的语义，不要误标死。
      return candidate;
    }
    this.markImageUnavailable(sticker.id, localized.reason || '图片地址已失效');
    return null;
  }

  note(id, patch) {
    const result = applyStickerNote(this.entries, id, patch);
    if (result.entry) this.saveEntries(result.entries);
    return result.entry;
  }

  addManual({
    imageBuffer,
    desc = '',
    localNote = '',
    tags = [],
    usage = ''
  }) {
    this.assertStorageWritable();
    const buffer = Buffer.isBuffer(imageBuffer)
      ? imageBuffer
      : Buffer.from(imageBuffer || []);
    if (!buffer.length) throw new Error('请选择表情图片');
    if (buffer.length > MAX_STICKER_BYTES) throw new Error('表情图片不能超过 8 MiB');
    const contentType = imageType(buffer);
    if (!contentType) throw new Error('仅支持 PNG、JPEG、GIF 或 WebP 图片');
    const id = `manual_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const relativeFile = this.#writeAsset(id, buffer, contentType);
    const now = new Date().toISOString();
    const entry = normalizeStickerEntry({
      id,
      resId: id,
      localFile: relativeFile,
      desc: cleanMetadata(desc, 80),
      localNote: cleanMetadata(localNote, 300),
      tags: Array.isArray(tags)
        ? tags.map((tag) => cleanMetadata(tag, 40)).filter(Boolean).slice(0, 20)
        : [],
      usage: cleanMetadata(usage, 300),
      source: 'manual',
      metadataEdited: true,
      createdAt: now,
      updatedAt: now
    });
    const nextEntries = [...this.entries, entry];
    try {
      this.saveEntries(nextEntries);
    } catch (error) {
      try { fs.rmSync(path.join(DATA_DIR, relativeFile), { force: true }); } catch { /* ignore */ }
      throw error;
    }
    return entry;
  }

  /**
   * 把一张图片写进本地资源目录，返回相对路径。
   * 只落盘不登记条目，调用方负责 saveEntries。
   */
  #writeAsset(id, buffer, contentType) {
    const ext = IMAGE_EXTENSIONS[contentType];
    if (!ext) throw new Error('不支持的图片格式');
    const relativeFile = `sticker-assets/${id}.${ext}`;
    const file = path.join(DATA_DIR, relativeFile);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buffer, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return relativeFile;
  }

  /**
   * 尝试把一个远端的临时图片地址固化成本地文件。
   *
   * 背景：QQ 消息图片地址带短期 rkey 签名，收藏时存下的 URL 过一段时间必然 400。
   * 只要在收藏那一刻抓到字节并且落盘，之后就能像手动表情一样用 base64:// 发送，
   * 不再受签名过期影响。
   *
   * 失败不抛错（返回 { ok:false }），让调用方决定降级策略：
   * 收藏动作本身不该因为图片暂时下载不到而整体失败。
   */
  async #localizeRemote(id, url, signal) {
    const target = String(url || '').trim();
    if (!/^https?:\/\//i.test(target)) {
      return { ok: false, reason: '图片地址不是 http(s)' };
    }
    let buffer;
    try {
      const safeUrl = await validateImageUrl(target);
      const fetched = await safeFetchBinary(safeUrl, MAX_STICKER_BYTES, signal);
      buffer = fetched?.buffer;
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error).slice(0, 200) };
    }
    if (!buffer || !buffer.length) return { ok: false, reason: '图片内容为空' };
    if (buffer.length > MAX_STICKER_BYTES) return { ok: false, reason: '图片超过 8 MiB' };
    const contentType = imageType(buffer);
    if (!contentType) return { ok: false, reason: '返回内容不是可识别的图片' };
    try {
      const relativeFile = this.#writeAsset(id, buffer, contentType);
      return { ok: true, localFile: relativeFile };
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error).slice(0, 200) };
    }
  }

  /**
   * 标记一个表情的远端地址已失效：不再参与列表/提示词，避免模型反复挑中。
   * 已有本地文件的条目不标记（它们本来就不依赖远端地址）。
   */
  markImageUnavailable(id, reason = '') {
    const target = findSticker(this.entries, id);
    if (!target || target.localFile) return null;
    const next = normalizeStickerEntry({
      ...target,
      imageUnavailableAt: Date.now(),
      imageUnavailableReason: cleanMetadata(reason, 200),
      updatedAt: new Date().toISOString()
    });
    const nextEntries = this.entries.map((entry) => (entry.id === target.id ? next : entry));
    this.saveEntries(nextEntries);
    return next;
  }

  update(id, patch = {}) {
    const target = findSticker(this.entries, id);
    if (!target) return null;
    const index = this.entries.findIndex((entry) => entry.id === target.id);
    const next = normalizeStickerEntry({
      ...target,
      desc: patch.desc !== undefined ? cleanMetadata(patch.desc, 80) : target.desc,
      localNote: patch.localNote !== undefined
        ? cleanMetadata(patch.localNote, 300)
        : target.localNote,
      tags: patch.tags !== undefined
        ? (Array.isArray(patch.tags) ? patch.tags : [])
        : target.tags,
      usage: patch.usage !== undefined ? cleanMetadata(patch.usage, 300) : target.usage,
      metadataEdited: true,
      updatedAt: new Date().toISOString()
    });
    const nextEntries = [...this.entries];
    nextEntries[index] = next;
    this.saveEntries(nextEntries);
    return next;
  }

  remove(id) {
    const target = findSticker(this.entries, id);
    if (!target) return null;
    const nextEntries = target.source === 'qq'
      ? this.entries.map((entry) =>
        entry.id === target.id
          ? normalizeStickerEntry({ ...entry, hidden: true, updatedAt: new Date().toISOString() })
          : entry)
      : this.entries.filter((entry) => entry.id !== target.id);
    this.saveEntries(nextEntries);
    let cleanupPending = false;
    let warning = '';
    if (target.localFile) {
      try {
        fs.rmSync(path.join(DATA_DIR, target.localFile), { force: true });
      } catch (error) {
        cleanupPending = true;
        warning = `表情已从资产库移除，但图片文件清理失败：${String(error?.message ?? error)}`;
      }
    }
    return { removed: true, cleanupPending, warning };
  }

  readImage(ref) {
    const sticker = findSticker(this.entries, ref);
    if (!sticker?.localFile) return null;
    const file = path.resolve(DATA_DIR, sticker.localFile);
    const root = `${path.resolve(STICKER_ASSET_DIR)}${path.sep}`;
    if (!file.startsWith(root)) return null;
    try {
      const buffer = fs.readFileSync(file);
      const contentType = imageType(buffer);
      return contentType ? { buffer, contentType } : null;
    } catch {
      return null;
    }
  }

  markUsed(id, context = '') {
    const result = markStickerUsed(this.entries, id, context);
    if (result.entry) this.saveEntries(result.entries);
    return result.entry;
  }

  /**
   * 收藏一条消息里的图片（本地新增条目，不入 QQ 收藏）。
   *
   * 收藏时就尝试把字节落盘：QQ 的图片地址带短期 rkey，此刻不抓，
   * 之后基本再也抓不到了（原消息一过期，签名也刷新不出来）。
   * 落盘失败仍然登记条目——用户刚明确收藏了它，本地条目不能凭空消失。
   */
  async collect(messageId, { url, note = '', signal } = {}) {
    if (!getConfig().sticker?.collectEnabled) throw new Error('收藏表情功能未开启');
    // 限频
    const now = Date.now();
    this.collectTimes = this.collectTimes.filter((t) => now - t < 3600000);
    if (this.collectTimes.length >= Math.max(1, Number(getConfig().sticker?.maxCollectPerHour) || 10)) {
      throw new Error('收藏太频繁了，一小时后再试');
    }
    url = String(url || '');
    if (!url) throw new Error('该消息没有可收藏的图片地址');
    const id = `collected_${messageId}`;
    const existing = this.entries.find((e) => e.id === id);
    if (existing) {
      return this.note(id, { note: String(note || '') });
    }

    const localized = await this.#localizeRemote(id, url, signal);
    const timestamp = new Date().toISOString();
    const entry = normalizeStickerEntry({
      id,
      resId: id,
      url,
      localFile: localized.ok ? localized.localFile : '',
      md5: '',
      desc: String(note || '').slice(0, 20),
      localNote: String(note || ''),
      tags: [],
      usage: '',
      source: 'ai',
      useCount: 0,
      lastUsedAt: 0,
      lastContext: '',
      createdAt: timestamp,
      updatedAt: timestamp
    });
    try {
      this.saveEntries([...this.entries, entry]);
    } catch (error) {
      if (localized.ok) {
        try { fs.rmSync(path.join(DATA_DIR, localized.localFile), { force: true }); } catch { /* ignore */ }
      }
      throw error;
    }
    this.collectTimes.push(now);
    return entry;
  }
}
