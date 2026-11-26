import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const directory = resolve(root, 'web/public/icons');
const vector = readFileSync(resolve(root, 'scripts/assets/icon-master.png'));
mkdirSync(resolve(root, 'scripts/assets'), { recursive: true });
for (const size of [32, 180, 192, 512]) {
  await sharp(vector).resize(size, size).png().toFile(resolve(directory, `icon-${size}.png`));
}
const sizes = [16, 32, 48, 256];
const images = await Promise.all(sizes.map(size => sharp(vector).resize(size, size).png().toBuffer()));
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (let index = 0; index < sizes.length; index++) {
  const start = 6 + index * 16;
  header[start] = sizes[index] % 256;
  header[start + 1] = sizes[index] % 256;
  header.writeUInt16LE(1, start + 4);
  header.writeUInt16LE(32, start + 6);
  header.writeUInt32LE(images[index].length, start + 8);
  header.writeUInt32LE(offset, start + 12);
  offset += images[index].length;
}
writeFileSync(resolve(root, 'scripts/assets/connector.ico'), Buffer.concat([header, ...images]));
const width = 164, height = 314, stride = Math.ceil(width * 3 / 4) * 4;
const welcomeIcon = await sharp(vector).resize(96,96).png().toBuffer();
const pixels = await sharp({create:{width,height,channels:3,background:'#f6f6f6'}}).composite([{input:welcomeIcon,left:34,top:102}]).removeAlpha().raw().toBuffer();
const bmp = Buffer.alloc(54 + stride * height);
bmp.write('BM'); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14);
bmp.writeInt32LE(width, 18); bmp.writeInt32LE(height, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const src = (y * width + x) * 3, dst = 54 + (height - 1 - y) * stride + x * 3;
  bmp[dst] = pixels[src + 2]; bmp[dst + 1] = pixels[src + 1]; bmp[dst + 2] = pixels[src];
}
writeFileSync(resolve(root, 'scripts/assets/welcome.bmp'), bmp);
console.log('Generated browser, web app and Windows icons.');
