// 车牌归一化工具（与小程序端保持一致）
const PROVINCES = '京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领'

function normalizePlate(raw) {
  if (!raw) return ''
  let p = String(raw).toUpperCase().replace(/[\s·\-.　]/g, '')
  // 纠正常见误识别：仅修正首位省份后的首字符（可能误识别成 O/0）以及车辆编号段（第 3 位起）的 I/O
  // 注意：发牌机关代号（第 2 位，如粤O、京O 的 O）必须是字母，不能替换为数字，否则会误伤政府号牌
  p = p.replace(/^O/, '0')
  if (p.length > 2) {
    // 第 3 位及之后（车辆序号段）才允许 O→0、I→1；保留第 2 位发牌机关字母
    p = p.slice(0, 2) + p.slice(2).replace(/I/g, '1').replace(/O/g, '0')
  }
  // 省份简称 + 字母 + 5~6 位（普通/新能源）
  const m = p.match(new RegExp('^[' + PROVINCES + '][A-Z][A-Z0-9]{5,6}$'))
  return m ? m[0] : p
}

function toPlateKey(plateNo) {
  return normalizePlate(plateNo)
}

module.exports = { normalizePlate, toPlateKey, PROVINCES }
