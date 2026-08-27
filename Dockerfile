# ============================================================
# 阶段 0 · base：node22-alpine + 系统运行依赖（所有 profile 共用）
# 注：不用 Debian slim 是为了体积（~60MB vs ~150MB base 层）；Alpine 3.20 带 node-22
# ============================================================
FROM node:22-alpine3.20 AS base
LABEL maintainer="QianMing Studio <admin@qmlpars.com>" \
      org.opencontainers.image.title="qmlpars" \
      org.opencontainers.image.description="乾明车牌识别自建后端" \
      org.opencontainers.image.licenses="AGPL-3.0"

# 系统依赖：libvips（sharp）、sqlite3 CLI（qm doctor 用）、curl/ca-certificates（OCR API 调用）、tini（1 号进程信号处理）
RUN apk add --no-cache --update \
        vips \
        vips-dev \
        sqlite \
        curl \
        ca-certificates \
        tini \
        tzdata \
        bash \
    && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone \
    && rm -rf /var/cache/apk/* \
    && mkdir -p /app

WORKDIR /app

# 先单独 COPY package-lock + 装依赖（利用 Docker layer cache）
COPY package.json ./
# 国内构建：--build-arg NPM_REGISTRY=https://registry.npmmirror.com 加速
ARG NPM_REGISTRY=https://registry.npmjs.org/
RUN --mount=type=cache,target=/root/.npm \
    npm config set registry "$NPM_REGISTRY" \
    && npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force || true

# ============================================================
# 阶段 1 · runtime：基础 + 代码（不含 Android SDK/JDK/Gradle）
# 镜像大小 ≈ 350MB，95% 部署场景用这个
# ============================================================
FROM base AS runtime
# 复制项目全部源码。.dockerignore 已排除 node_modules/ / data/ / uploads/ / .git/ / dist/
COPY . .
# 运行时目录（挂载点）：.env 允许外部替换，data/uploads/backups 持久化
RUN mkdir -p /app/data /app/uploads/assets /app/uploads/snapshots \
    && chmod -R u+rwX,g+rX /app /app/data /app/uploads \
    && chmod +x /app/qm /app/entrypoint.sh || true

EXPOSE 7081
# qm 命令、qm doctor 日志等用 bash 作为交互入口
ENV SHELL=/bin/bash \
    NODE_ENV=production \
    QMLPARS_HOME=/app

ENTRYPOINT ["/sbin/tini", "--", "/app/entrypoint.sh"]
CMD ["node", "index.js"]

# ============================================================
# 阶段 2 · builder-base：runtime + JDK17 + Android SDK + Gradle 预热
# 镜像大小 ≈ 4.2GB，仅限需要在容器里「APP 打包」的机器
# 注意：必须用 Debian 因为 Android SDK command-line tools 只发行 glibc 版，musl(alpine) 跑不了
# ============================================================
FROM eclipse-temurin:17-jdk-jammy AS builder-base
LABEL stage=builder-intermediate
ENV DEBIAN_FRONTEND=noninteractive \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    ANDROID_HOME=/opt/android-sdk \
    GRADLE_USER_HOME=/var/cache/gradle \
    JAVA_HOME=/opt/java/openjdk
# Node 22 + 运行依赖
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends \
        nodejs npm curl ca-certificates unzip tzdata \
        libvips42 libvips-dev sqlite3 tini bash \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# 装 Android command-line tools + 平台组件（国内镜像 + 重试 3 次 + 腾讯云 Gradle zip）
RUN mkdir -p ${ANDROID_SDK_ROOT}/cmdline-tools \
    && TMP_ZIP="/tmp/cmdtools.zip" \
    && for i in 1 2 3; do \
          curl -fL --connect-timeout 30 --retry 3 -o "$TMP_ZIP" \
            "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip" \
            && break; sleep 5; done \
    && unzip -q -o "$TMP_ZIP" -d "${ANDROID_SDK_ROOT}/cmdline-tools" \
    && mv "${ANDROID_SDK_ROOT}/cmdline-tools/cmdline-tools" "${ANDROID_SDK_ROOT}/cmdline-tools/latest" \
    && chmod +x ${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin/* \
    && rm -f "$TMP_ZIP" \
    && yes | ${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin/sdkmanager --licenses >/dev/null 2>&1 || true \
    && ${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin/sdkmanager \
          "platform-tools" "platforms;android-35" "build-tools;35.0.0" \
    # 预热 Gradle 8.2.1（直接用腾讯云镜像下载到 GRADLE_USER_HOME/wrapper/dists）
    && mkdir -p ${GRADLE_USER_HOME}/wrapper/dists/gradle-8.2.1-all/*/ \
    && curl -fSL -o ${GRADLE_USER_HOME}/wrapper/dists/gradle-8.2.1-all.zip \
          "https://mirrors.cloud.tencent.com/gradle/gradle-8.2.1-all.zip" \
    && unzip -q -o ${GRADLE_USER_HOME}/wrapper/dists/gradle-8.2.1-all.zip \
          -d ${GRADLE_USER_HOME}/wrapper/dists/gradle-8.2.1-all/ \
    && rm -f ${GRADLE_USER_HOME}/wrapper/dists/gradle-8.2.1-all.zip || true

WORKDIR /app
# npm install（复用 buildx cache）
COPY package.json ./
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN --mount=type=cache,target=/root/.npm \
    npm config set registry "$NPM_REGISTRY" \
    && npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force || true

# 最终：builder（runtime 相同的代码 + 构建链）
FROM builder-base AS builder
COPY . .
RUN mkdir -p /app/data /app/uploads/assets /app/uploads/snapshots \
             /root/.android /app/dist/builds \
    && chmod -R u+rwX,g+rX /app \
    && [ -f /app/android-app/android/gradlew ] \
    && chmod +x /app/android-app/android/gradlew /app/qm || true

ENV PATH=$JAVA_HOME/bin:${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin:${ANDROID_SDK_ROOT}/platform-tools:$PATH \
    NODE_ENV=production \
    QMLPARS_HOME=/app

EXPOSE 7081
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
CMD ["node", "index.js"]
