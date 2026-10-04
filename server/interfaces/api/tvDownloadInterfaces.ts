export interface TvDownloadEpisode {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  monitored: boolean;
  hasFile: boolean;
  airDateUtc?: string;
  state: 'imported' | 'queued' | 'unmonitored' | 'unaired' | 'missing';
  queue: {
    title: string;
    status: string;
    trackedStatus: string;
    trackedState: string;
    progress: number | null;
    messages: string[];
  }[];
  history: {
    date: string;
    eventType: string;
    title: string;
    message?: string;
  }[];
}
export interface TvDownloadDiagnostics {
  serverName: string;
  is4k: boolean;
  seriesMonitored: boolean;
  episodes: TvDownloadEpisode[];
  queueTruncated: boolean;
  historyTruncated: boolean;
}
export interface TvDownloadRelease {
  token?: string;
  title: string;
  indexer: string;
  quality: string;
  size: number;
  seeders: number | null;
  protocol: string;
  fullSeason: boolean;
  episodeNumbers: number[];
  rejections: string[];
  rejected: boolean;
  duplicate: boolean;
}
export interface TvDownloadSearch {
  releases: TvDownloadRelease[];
  expiresAt: string;
  truncated: boolean;
}
