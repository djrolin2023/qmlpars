const axios = require('axios')
const crypto = require('crypto')
const { normalizePlate } = require('./plate')
const config = require('./config')

let cachedToken = null
let tokenExpireAt = 0

// 获取百度 access_token（缓存，提前 5 分钟刷新）
async function getBaiduToken() {
  const now = Date.now()
  if (cachedToken && now < tokenExpireAt) return cachedToken
  const url = 'https://aip.baidubce.com/oauth/2.0/token'
  const res = await axios.get(url, {
    params: {
      grant_type: 'client_credentials',
      client_id: config.BAIDU_API_KEY,
      client_secret: config.BAIDU_SECRET_KEY
    },
    timeout: 8000
  })
  if (!res.data || !res.data.access_token) {
    throw new Error('百度获取 access_token 失败')
  }
  cachedToken = res.data.access_token
  tokenExpireAt = now + (res.data.expires_in - 300) * 1000
  return cachedToken
}

// 百度车牌识别：支持 base64 或图片 URL
async function recognizeByBaidu(imageBase64, imageUrl) {
  if (!config.BAIDU_ENABLED) throw new Error('百度 OCR 未配置')
  const token = await getBaiduToken()
  const url = `https://aip.baidubce.com/rest/2.0/ocr/v1/license_plate?access_token=${token}`

  const params = new URLSearchParams()
  params.append('license_plate_number', 'true')
  if (imageBase64) {
    params.append('image', imageBase64)
  } else if (imageUrl) {
    params.append('url', imageUrl)
  } else {
    throw new Error('缺少图片数据')
  }

  const res = await axios.post(url, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000
  })

  if (res.data && res.data.error_code) {
    throw new Error(`百度 OCR 错误: ${res.data.error_code} ${res.data.error_msg || ''}`)
  }
  const rawPlate = res.data && res.data.words_result && res.data.words_result.number
  if (!rawPlate) throw new Error('百度未识别到车牌')
  const plateNo = normalizePlate(rawPlate)
  return {
    plateNo,
    confidence: res.data.words_result && res.data.words_result.confidence
      ? Number(res.data.words_result.confidence) : 0,
    color: res.data.words_result && res.data.words_result.color || ''
  }
}

// 腾讯云 OCR 签名（API 3.0 签名 v3，TC3-HMAC-SHA256）
function tencentSignature(secretId, secretKey, service, action, region, payload) {
  const host = `${service}.tencentcloudapi.com`
  const algorithm = 'TC3-HMAC-SHA256'
  const timestamp = Math.floor(Date.now() / 1000)
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10) // YYYY-MM-DD

  // 1. 拼接规范请求串
  const httpRequestMethod = 'POST'
  const canonicalUri = '/'
  const canonicalQueryString = ''
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`
  const signedHeaders = 'content-type;host'
  const payloadHash = crypto.createHash('sha256').update(payload, 'utf8').digest('hex')
  const canonicalRequest = [
    httpRequestMethod, canonicalUri, canonicalQueryString, canonicalHeaders,
    signedHeaders, payloadHash
  ].join('\n')

  // 2. 拼接待签名字符串
  const credentialScope = `${date}/${service}/tc3_request`
  const stringToSign = [
    algorithm, timestamp, credentialScope,
    crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')
  ].join('\n')

  // 3. 计算签名
  const secretDate = crypto.createHmac('sha256', 'TC3' + secretKey).update(date).digest()
  const secretService = crypto.createHmac('sha256', secretDate).update(service).digest()
  const secretSigning = crypto.createHmac('sha256', secretService).update('tc3_request').digest()
  const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign).digest('hex')

  // 4. 拼接 Authorization
  const authorization = `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return { authorization, timestamp, host }
}

async function recognizeByTencent(imageBase64, imageUrl) {
  if (!config.TENCENT_ENABLED) throw new Error('腾讯 OCR 未配置')
  const payload = JSON.stringify(imageBase64 ? { ImageBase64: imageBase64 } : { ImageUrl: imageUrl })
  const { authorization, timestamp, host } = tencentSignature(
    config.TENCENT_SECRET_ID, config.TENCENT_SECRET_KEY, 'ocr', 'LicensePlateOCR',
    config.TENCENT_REGION, payload
  )
  const res = await axios.post(`https://${host}/`, payload, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Host': host,
      'X-TC-Action': 'LicensePlateOCR',
      'X-TC-Version': '2018-11-19',
      'X-TC-Region': config.TENCENT_REGION,
      'X-TC-Timestamp': timestamp,
      'Authorization': authorization
    },
    timeout: 15000
  })
  const resp = res.data && res.data.Response
  if (!resp || resp.Error) {
    throw new Error('腾讯 OCR 错误: ' + (resp && resp.Error ? resp.Error.Code + ' ' + resp.Error.Message : '未知错误'))
  }
  const item = resp.LicensePlateInfos && resp.LicensePlateInfos[0]
  if (!item || !item.Number) throw new Error('腾讯未识别到车牌')
  return {
    plateNo: normalizePlate(item.Number),
    confidence: item.Confidence != null ? Number(item.Confidence) : 0,
    color: item.Color || ''
  }
}

// 从嵌套响应对象按点号路径取值
function resolvePath(obj, path) {
  if (!path) return undefined
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

// 替换模板中的 {{base64}} / {{url}}
function applyTemplate(template, vars) {
  if (typeof template !== 'string') return JSON.stringify(template)
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = vars[key]
    return v != null ? v : ''
  })
}

// 阿里云车牌识别（官方 RPC 接口 RecognizeLicensePlate，AccessKey 签名）
async function recognizeByAliyun(imageBase64, imageUrl) {
  if (!config.ALIYUN_ENABLED) throw new Error('阿里云 OCR 未配置')
  const accessKeyId = config.ALIYUN_ACCESS_KEY_ID
  const accessKeySecret = config.ALIYUN_ACCESS_KEY_SECRET
  const region = config.ALIYUN_REGION || 'cn-shanghai'
  const endpoint = `https://ocr.${region}.aliyuncs.com/`
  const action = 'RecognizeLicensePlate'
  const version = '2019-12-30'

  // 业务参数：优先图片 URL（ImageURL），否则传 Base64（Image，需 URLEncode）
  const params = {
    Action: action,
    Version: version,
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    AccessKeyId: accessKeyId,
    Timestamp: new Date().toISOString(),
    SignatureNonce: crypto.randomUUID(),
  }
  if (imageUrl) params.ImageURL = imageUrl
  else if (imageBase64) params.Image = imageBase64

  const signed = aliyunSign(params, accessKeySecret)
  params.Signature = signed

  const res = await axios.get(endpoint, { params, timeout: 15000 })
  const plates = res.data && res.data.Data && res.data.Data.Plates
  if (!plates || !plates.length || !plates[0].PlateNumber) {
    throw new Error('阿里云未识别到车牌')
  }
  const p = plates[0]
  return {
    plateNo: normalizePlate(p.PlateNumber),
    confidence: p.Confidence != null ? Number(p.Confidence) : 0,
    color: '' // 阿里云车牌识别接口不返回颜色
  }
}

// 阿里云 RPC 签名（HMAC-SHA1 + Base64），参考官方公共参数签名规范
function aliyunSign(params, accessKeySecret) {
  const sorted = Object.keys(params).sort()
  const canonical = sorted.map(k => {
    return `${percentEncode(k)}=${percentEncode(params[k])}`
  }).join('&')
  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonical)}`
  const hmac = crypto.createHmac('sha1', accessKeySecret + '&')
  hmac.update(stringToSign, 'utf8')
  return hmac.digest('base64')
}

function percentEncode(str) {
  return encodeURIComponent(String(str))
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~')
}

// 华为云车牌识别（官方接口 /v2/{project_id}/ocr/license-plate，AK/SK 签名）
async function recognizeByHuawei(imageBase64, imageUrl) {
  if (!config.HUAWEI_ENABLED) throw new Error('华为云 OCR 未配置')
  const ak = config.HUAWEI_AK
  const sk = config.HUAWEI_SK
  const projectId = config.HUAWEI_PROJECT_ID
  const region = config.HUAWEI_REGION || 'cn-north-4'
  const endpoint = `https://ocr.${region}.myhuaweicloud.com`
  const url = `${endpoint}/v2/${projectId}/ocr/license-plate`

  const body = {}
  if (imageBase64) body.image = imageBase64
  else if (imageUrl) body.url = imageUrl
  else throw new Error('缺少图片数据')

  const { authorization, date } = huaweiSign(ak, sk, projectId, region, JSON.stringify(body))
  const res = await axios.post(url, body, {
    headers: {
      'Content-Type': 'application/json',
      'X-Sdk-Date': date,
      'X-Project-Id': projectId,
      'Authorization': authorization
    },
    timeout: 15000
  })
  const result = res.data && res.data.result
  const item = result && result[0]
  if (!item || !item.plate_number) throw new Error('华为云未识别到车牌')
  return {
    plateNo: normalizePlate(item.plate_number),
    confidence: item.confidence != null ? Number(item.confidence) : 0,
    color: item.plate_color || ''
  }
}

// 华为云 AK/SK 签名（SDK-HMAC-SHA256）
function huaweiSign(ak, sk, projectId, region, bodyStr) {
  const sdkDate = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '')
  const dateStamp = sdkDate.slice(0, 8)
  const host = `ocr.${region}.myhuaweicloud.com`

  const canonicalHeaders = `host:${host}\nx-sdk-date:${sdkDate}\n`
  const signedHeaders = 'host;x-sdk-date'
  const hashedPayload = crypto.createHash('sha256').update(bodyStr, 'utf8').digest('hex')
  const canonicalRequest = [
    'POST', '/v2/' + projectId + '/ocr/license-plate',
    '', canonicalHeaders, signedHeaders, hashedPayload
  ].join('\n')

  const algorithm = 'SDK-HMAC-SHA256'
  const scope = `${dateStamp}/${region}/ocr/sha256`
  const canonicalRequestHash = crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')
  const stringToSign = `${algorithm}\n${sdkDate}\n${scope}\n${canonicalRequestHash}`

  const kDate = crypto.createHmac('sha256', ('SDK' + sk)).update(dateStamp).digest()
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest()
  const kService = crypto.createHmac('sha256', kRegion).update('ocr').digest()
  const kSigning = crypto.createHmac('sha256', kService).update('sha256').digest()
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex')

  const authorization = `${algorithm} Access=${ak}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return { authorization, date: sdkDate }
}

// 完全自定义 OCR：URL、方法、Headers、Body、字段映射全部可配
async function recognizeByCustom(imageBase64, imageUrl) {
  if (!config.CUSTOM_OCR_ENABLED) throw new Error('自定义 OCR 未配置')
  const url = config.CUSTOM_OCR_URL
  if (!url) throw new Error('缺少 CUSTOM_OCR_URL')
  const method = String(config.CUSTOM_OCR_METHOD || 'POST').toUpperCase()
  let headers = { 'Content-Type': 'application/json' }
  try {
    if (config.CUSTOM_OCR_HEADERS) headers = Object.assign(headers, JSON.parse(config.CUSTOM_OCR_HEADERS))
  } catch (_) { /* 忽略非法 headers */ }
  const bodyTemplate = config.CUSTOM_OCR_BODY_TEMPLATE || '{"image":"{{base64}}"}'
  const body = applyTemplate(bodyTemplate, { base64: imageBase64 || '', url: imageUrl || '' })
  let res
  if (method === 'GET') {
    res = await axios.get(url, { headers, timeout: 15000, params: JSON.parse(body) })
  } else {
    res = await axios.post(url, body, { headers, timeout: 15000 })
  }
  const plateField = config.CUSTOM_OCR_PLATE_FIELD || 'plateNo'
  const confField = config.CUSTOM_OCR_CONFIDENCE_FIELD || 'confidence'
  const colorField = config.CUSTOM_OCR_COLOR_FIELD || 'color'
  const rawPlate = resolvePath(res.data, plateField)
  if (!rawPlate) throw new Error('自定义 OCR 未识别到车牌')
  return {
    plateNo: normalizePlate(rawPlate),
    confidence: Number(resolvePath(res.data, confField) || 0),
    color: resolvePath(res.data, colorField) || ''
  }
}

module.exports = { recognizeByBaidu, recognizeByTencent, recognizeByAliyun, recognizeByHuawei, recognizeByCustom }
