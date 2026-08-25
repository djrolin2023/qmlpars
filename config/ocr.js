// OCR 各通道配置
// 工厂函数：接收 dbGet，返回 OCR 配置对象（保留 getter 实时性）
module.exports = function (dbGet) {
  return {
    // 百度 OCR 配置（车牌识别）
    get BAIDU_API_KEY() { return dbGet('BAIDU_API_KEY', process.env.BAIDU_API_KEY || '') },
    get BAIDU_SECRET_KEY() { return dbGet('BAIDU_SECRET_KEY', process.env.BAIDU_SECRET_KEY || '') },
    get BAIDU_ENABLED() { return !!(this.BAIDU_API_KEY && this.BAIDU_SECRET_KEY) },

    // 腾讯云 OCR 配置（车牌识别备用通道）
    get TENCENT_SECRET_ID() { return dbGet('TENCENT_SECRET_ID', process.env.TENCENT_SECRET_ID || '') },
    get TENCENT_SECRET_KEY() { return dbGet('TENCENT_SECRET_KEY', process.env.TENCENT_SECRET_KEY || '') },
    get TENCENT_REGION() { return dbGet('TENCENT_REGION', process.env.TENCENT_REGION || 'ap-guangzhou') },
    get TENCENT_ENABLED() { return !!(this.TENCENT_SECRET_ID && this.TENCENT_SECRET_KEY) },

    // 阿里云 OCR 配置（官方车牌识别：AccessKey 签名）
    get ALIYUN_ACCESS_KEY_ID() { return dbGet('ALIYUN_ACCESS_KEY_ID', process.env.ALIYUN_ACCESS_KEY_ID || '') },
    get ALIYUN_ACCESS_KEY_SECRET() { return dbGet('ALIYUN_ACCESS_KEY_SECRET', process.env.ALIYUN_ACCESS_KEY_SECRET || '') },
    get ALIYUN_REGION() { return dbGet('ALIYUN_REGION', process.env.ALIYUN_REGION || 'cn-shanghai') },
    get ALIYUN_ENABLED() { return !!(this.ALIYUN_ACCESS_KEY_ID && this.ALIYUN_ACCESS_KEY_SECRET) },

    // 华为云 OCR 配置（官方车牌识别：Ak/Sk 签名）
    get HUAWEI_AK() { return dbGet('HUAWEI_AK', process.env.HUAWEI_AK || '') },
    get HUAWEI_SK() { return dbGet('HUAWEI_SK', process.env.HUAWEI_SK || '') },
    get HUAWEI_PROJECT_ID() { return dbGet('HUAWEI_PROJECT_ID', process.env.HUAWEI_PROJECT_ID || '') },
    get HUAWEI_REGION() { return dbGet('HUAWEI_REGION', process.env.HUAWEI_REGION || 'cn-north-4') },
    get HUAWEI_ENABLED() { return !!(this.HUAWEI_AK && this.HUAWEI_SK && this.HUAWEI_PROJECT_ID) },

    // 自定义 OCR 配置
    get CUSTOM_OCR_URL() { return dbGet('CUSTOM_OCR_URL', process.env.CUSTOM_OCR_URL || '') },
    get CUSTOM_OCR_METHOD() { return dbGet('CUSTOM_OCR_METHOD', process.env.CUSTOM_OCR_METHOD || 'POST') },
    get CUSTOM_OCR_HEADERS() { return dbGet('CUSTOM_OCR_HEADERS', process.env.CUSTOM_OCR_HEADERS || '') },
    get CUSTOM_OCR_BODY_TEMPLATE() { return dbGet('CUSTOM_OCR_BODY_TEMPLATE', process.env.CUSTOM_OCR_BODY_TEMPLATE || '{"image":"{{base64}}"}') },
    get CUSTOM_OCR_PLATE_FIELD() { return dbGet('CUSTOM_OCR_PLATE_FIELD', process.env.CUSTOM_OCR_PLATE_FIELD || 'plateNo') },
    get CUSTOM_OCR_CONFIDENCE_FIELD() { return dbGet('CUSTOM_OCR_CONFIDENCE_FIELD', process.env.CUSTOM_OCR_CONFIDENCE_FIELD || 'confidence') },
    get CUSTOM_OCR_COLOR_FIELD() { return dbGet('CUSTOM_OCR_COLOR_FIELD', process.env.CUSTOM_OCR_COLOR_FIELD || 'color') },
    get CUSTOM_OCR_ENABLED() { return !!(this.CUSTOM_OCR_URL) },
  }
}
