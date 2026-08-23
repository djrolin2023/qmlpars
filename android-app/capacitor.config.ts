import { CapacitorConfig } from '@capacitor/cli';
const config: CapacitorConfig = {
  appId: "cn.qmlpars.com",
  appName: "乾明车牌识别",
  webDir: 'www',
  server: { androidScheme: 'https' },
  plugins: { SplashScreen: { launchShowDuration: 3000, backgroundColor: "#0f172a", androidScaleType: 'CENTER_CROP' } }
};
export default config;
