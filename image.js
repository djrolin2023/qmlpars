// 透明 PNG 自动合成项目主色渐变底，输出不透明图（用于安卓 APP / 移动端展示统一）
// 主渐变：linear-gradient(135deg, #1890FF -> #36CFC9)
const sharp = require('sharp')

const GRADIENT_SVG = (w, h) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
  `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
  `<stop offset="0%" stop-color="#1890FF"/>` +
  `<stop offset="100%" stop-color="#36CFC9"/>` +
  `</linearGradient></defs>` +
  `<rect width="100%" height="100%" fill="url(#g)"/></svg>`

// 判断 PNG 是否含实际透明像素（alpha 通道最小值 < 255）
async function hasTransparency(filePath) {
  const meta = await sharp(filePath).metadata()
  if (meta.format !== 'png' || !meta.hasAlpha) return false
  const stats = await sharp(filePath).stats()
  const alpha = stats.channels.find(c => c.alpha)
  if (!alpha) return false
  return alpha.min < 255
}

// 把透明 PNG 合成渐变底，覆盖写回原文件（输出为不透明 PNG）
async function flattenIfTransparent(filePath) {
  try {
    const transparent = await hasTransparency(filePath)
    if (!transparent) return
    const meta = await sharp(filePath).metadata()
    const w = meta.width, h = meta.height
    const base = await sharp(Buffer.from(GRADIENT_SVG(w, h))).resize(w, h).png().toBuffer()
    const out = await sharp(base)
      .composite([{ input: filePath, gravity: 'center', left: 0, top: 0 }])
      .png()
      .toBuffer()
    await sharp(out).toFile(filePath)
  } catch (e) {
    // 合成失败不影响原图保存，仅记录
    console.error('[image] 透明合成失败:', e.message)
  }
}

// 为 OCR 压缩图片：最长边缩至 maxEdge，转 JPEG，返回 base64。
// 车牌识别对分辨率不敏感，压缩可显著降低 base64 体积（减少内存与请求体）。
async function compressForOcr(filePath, maxEdge = 1600, quality = 80) {
  try {
    const img = sharp(filePath)
    const meta = await img.metadata()
    const long = Math.max(meta.width || 0, meta.height || 0)
    if (long > maxEdge) {
      const buf = await img.resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true }).jpeg({ quality }).toBuffer()
      return buf.toString('base64')
    }
    return img.jpeg({ quality }).toBuffer().then(b => b.toString('base64'))
  } catch (e) {
    console.error('[image] OCR 压缩失败，回退原图:', e.message)
    try { return require('fs').readFileSync(filePath).toString('base64') } catch (_) { return null }
  }
}

module.exports = { flattenIfTransparent, hasTransparency, compressForOcr }
