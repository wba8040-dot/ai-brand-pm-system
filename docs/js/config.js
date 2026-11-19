/**
 * 系統設定
 * SUPABASE_URL 與 SUPABASE_ANON_KEY 可以公開（安全性由資料庫的 RLS 控管）。
 * 位置：Supabase → Project Settings → API Keys
 * ⚠️ 絕對不要把 service_role / Secret key 放在這裡。
 */
window.APP_CONFIG = Object.freeze({
  SUPABASE_URL: 'https://iozsdzbumklzbamegyol.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_5KTvsVPFWFGahqohQhC6UA_JRgVwiaL',

  APP_NAME: 'AI 品牌行銷專案管理與成效預警系統',
  APP_SHORT: '品牌行銷 PM',
  MIN_PASSWORD: 8,          // 新密碼最少長度
  REFRESH_SECONDS: 60,      // 自動重新整理間隔（秒）
  ROAS_TARGET: 3.5          // 儀表板 ROAS 目標線
});
