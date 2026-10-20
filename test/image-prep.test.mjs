import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { prepareImageDataUrls } from '../src/image-prep.js';

function decode(dataUrl) {
  assert.match(dataUrl, /^data:image\/jpeg;base64,/);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

test('超长截图会切成多段并缩到上限以内', async () => {
  const input = await sharp({
    create: { width: 400, height: 9000, channels: 3, background: '#ffffff' }
  }).png().toBuffer();

  const result = await prepareImageDataUrls(input, { maxSide: 1024 });
  assert.equal(result.format, 'png');
  assert.equal(result.width, 400);
  assert.equal(result.height, 9000);
  assert.equal(result.segments, 3);
  assert.equal(result.dataUrls.length, 3);
  assert.match(result.note, /切成 3 段/);

  for (const dataUrl of result.dataUrls) {
    const meta = await sharp(decode(dataUrl)).metadata();
    assert.equal(meta.format, 'jpeg');
    assert.ok(Math.max(meta.width, meta.height) <= 1024);
  }
});

test('普通图片只压缩不切段', async () => {
  const input = await sharp({
    create: { width: 800, height: 600, channels: 3, background: '#336699' }
  }).jpeg().toBuffer();

  const result = await prepareImageDataUrls(input, { maxSide: 320 });
  assert.equal(result.segments, 1);
  assert.equal(result.dataUrls.length, 1);

  const meta = await sharp(decode(result.dataUrls[0])).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 320);
  assert.equal(meta.height, 240);
});

test('split=false 时超长图也不切段', async () => {
  const input = await sharp({
    create: { width: 300, height: 7000, channels: 3, background: '#ffffff' }
  }).png().toBuffer();

  const result = await prepareImageDataUrls(input, { split: false, maxSide: 512 });
  assert.equal(result.segments, 1);
  assert.equal(result.dataUrls.length, 1);
});

test('拒绝非视觉接口支持的图片格式', async () => {
  const input = await sharp({
    create: { width: 64, height: 64, channels: 3, background: '#ffffff' }
  }).tiff().toBuffer();

  await assert.rejects(
    () => prepareImageDataUrls(input),
    /图片格式不支持：tiff/
  );
});

test('拒绝无法解析的图片内容', async () => {
  await assert.rejects(
    () => prepareImageDataUrls(Buffer.from('not an image at all')),
    /图片无法解析/
  );
  await assert.rejects(() => prepareImageDataUrls(Buffer.alloc(0)), /图片内容为空/);
});
