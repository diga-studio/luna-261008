/** 一张幻灯片：内容 id + 播放时长（秒，5~120）。 */
export interface Slide {
  contentId: string;
  durationSec: number;
}

/** 播放列表：有序幻灯片序列，允许重复 contentId。 */
export interface Playlist {
  id: string;
  slides: Slide[];
}

/** 每日班次窗口（本地钟面时间，"HH:mm"）。 */
export interface ShiftWindow {
  id: string;
  group: string;
  priority: number; // 1~4
  playlistId: string;
  startLocal: string; // "HH:mm"
  endLocal: string; // "HH:mm"
}

/** 紧急告警：绝对 UTC 毫秒区间，左闭右开，优先级固定 5。 */
export interface EmergencyAlert {
  id: string;
  group: string;
  contentId: string;
  startUtcMs: number;
  endUtcMs: number;
}

/** 完整配置，调用期间不可变。 */
export interface PlaybackConfig {
  playlists: Playlist[];
  windows: ShiftWindow[];
  alerts: EmergencyAlert[];
}

/** 一帧：获选窗口或告警的 id + 当前内容；空闲为 null。 */
export interface Frame {
  sourceId: string;
  contentId: string;
}

/** 播放段：[startUtcMs, endUtcMs) 内恒为 frame。 */
export interface TimelineSegment {
  startUtcMs: number;
  endUtcMs: number;
  frame: Frame | null;
}
