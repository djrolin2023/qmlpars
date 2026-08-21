// 车牌归一化工具（与小程序端保持一致）
const PROVINCES = '京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领'

function normalizePlate(raw) {
  if (!raw) return ''
  let p = String(raw).toUpperCase().replace(/[\s·\-.　]/g, '')
  // 纠正常见误识别
  p = p.replace(/^O/, '0')
  p = p.replace(/I/g, '1').replace(/O/g, '0')
  // 省份简称 + 字母 + 5~6 位（普通/新能源）
  const m = p.match(new RegExp('^[' + PROVINCES + '][A-Z][A-Z0-9]{5,6}$'))
  return m ? m[0] : p
}

function toPlateKey(plateNo) {
  return normalizePlate(plateNo)
}

module.exports = { normalizePlate, toPlateKey, PROVINCES }
