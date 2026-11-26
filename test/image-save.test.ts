import assert from 'node:assert/strict';
import test from 'node:test';
import { imageFileFromDownload, canShareImage, shareImage } from '../web/src/image-save';

test('saving uses unchanged original bytes and actual image MIME rather than a misleading extension', async () => {
  const original = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 12, 34, 56, 78]);
  const file = await imageFileFromDownload(new Blob([original]), '原图.jpg');
  assert.equal(file.type, 'image/png');
  assert.equal(file.name, '原图.png');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), original);
  const jpeg = await imageFileFromDownload(new Blob([Uint8Array.from([255, 216, 255, 224])]), 'photo.png');
  assert.equal(jpeg.type, 'image/jpeg');
  const webp = await imageFileFromDownload(new Blob(['RIFFxxxxWEBPVP8 ']), 'photo.png');
  assert.equal(webp.type, 'image/webp');
  await assert.rejects(imageFileFromDownload(new Blob(['<html>not an image</html>']), 'photo.png'), /image_save_format_not_supported/);
});

test('sharing invokes the OS before yielding the click and sends the image file, not its URL or preview', async () => {
  const file = new File(['original'], 'photo.png', { type: 'image/png' });
  let invoked = false;
  const operation = shareImage(file, {
    canShare: data => data?.files?.[0] === file,
    share: async data => {
      invoked = true;
      assert.deepEqual(data, { files: [file] });
    },
  });
  assert.equal(invoked, true);
  assert.equal(await operation, 'shared');
});

test('unsupported sharing and cancellation retain the image while real share errors remain actionable', async () => {
  const file = new File(['original'], 'photo.png', { type: 'image/png' });
  assert.equal(canShareImage(file, {}), false);
  assert.equal(canShareImage(file, { canShare() { throw Error('unsupported'); } }), false);
  assert.equal(await shareImage(file, {}), 'unavailable');
  const cancelled = Object.assign(new Error('Dismissed'), { name: 'AbortError' });
  assert.equal(await shareImage(file, { canShare: () => true, share: async () => { throw cancelled; } }), 'cancelled');
  await assert.rejects(shareImage(file, { canShare: () => true, share: async () => { throw Error('blocked'); } }), /blocked/);
});
