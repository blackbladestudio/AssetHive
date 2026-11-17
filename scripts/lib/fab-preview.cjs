const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { runImageTask } = require('../../electron/services/imageTasks');

// Use the same local Silueta task as AssetHive's Remove Background button.
async function transparentPreview(source, output, { method = 'smart' } = {}) {
  if (!['smart', 'color'].includes(method)) throw new Error('无效的去背景方式');
  await fs.mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.cutout.png`;
  const result = method === 'color'
    ? await runImageTask('autoPreviewCutout', [source, temporary, 10, true])
    : await runImageTask('smartCutout', [source, temporary, {
      modelPath: path.resolve(__dirname, '../../electron/models/silueta.onnx')
    }]);
  if (!result?.ok) throw new Error(result?.message || '软件智能去背景失败');
  await runImageTask('resizeTexture', [temporary, output, 1024]);
  const metadata = await sharp(output).metadata(), stats = await sharp(output).stats();
  if (!metadata.hasAlpha || stats.channels[3]?.min !== 0 || !stats.channels[3]?.max) throw new Error('去背景结果没有有效透明通道');
  await fs.unlink(temporary);
  return { path: output, width: metadata.width, height: metadata.height };
}

module.exports = { transparentPreview };
