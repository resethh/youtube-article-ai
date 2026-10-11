/** 共享类型定义 */

export interface CaptionSegment {
  /** 起始时间，mm:ss 形式 */
  time: string;
  text: string;
}

/** 字幕获取结果：成功返回 segments，失败/兜底返回 fallbackReason */
export interface CaptionResult {
  videoId: string;
  title: string;
  segments: CaptionSegment[];
  /** 实际使用的字幕来源 */
  source: 'youtube' | 'proxy' | 'demo';
  /** 降级原因（仅非 youtube 来源时有值），如 youtube_empty_body / youtube_no_caption_tracks */
  fallbackReason?: string;
}

/** 降级原因枚举，供前端徽章展示 */
export type FallbackReason =
  | 'youtube_empty_body'
  | 'youtube_invalid_json'
  | 'youtube_playability_error'
  | 'youtube_no_caption_tracks'
  | 'timedtext_empty_body'
  | 'youtube_captcha'
  | 'youtube_rate_limited'
  | 'youtube_network_error'
  | 'proxy_failed'
  | 'no_captions_available';

export interface ParsedRequirements {
  taskType?: string;
  outputStyle?: string;
  audience?: string;
  constraints?: string;
}

export interface Chapter {
  index: number;
  title: string;
}

export interface SessionContext {
  videoId: string;
  title: string;
  captions: CaptionSegment[];
  requirements?: ParsedRequirements;
  article: string;
  chapters: Chapter[];
  createdAt: number;
  expiresAt: number;
}
