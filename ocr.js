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

module.exports = { recognizeByBaidu, recognizeByTencent }
