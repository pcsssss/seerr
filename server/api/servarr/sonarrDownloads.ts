import SonarrAPI, {
  type EpisodeResult,
  type SonarrSeries,
} from '@server/api/servarr/sonarr';

export interface SonarrDownloadQueue {
  seriesId?: number;
  episodeId?: number;
  title: string;
  status: string;
  trackedDownloadStatus: string;
  trackedDownloadState: string;
  size: number;
  sizeleft: number;
  statusMessages?: { title: string; messages: string[] }[];
}
export interface SonarrDownloadHistory {
  seriesId?: number;
  episodeId: number;
  date: string;
  eventType: string;
  sourceTitle: string;
  data?: { message?: string };
}
export interface SonarrRelease {
  guid: string;
  indexerId: number;
  title: string;
  indexer: string;
  quality?: { quality?: { name?: string } };
  size: number;
  seeders?: number;
  protocol: string;
  fullSeason: boolean;
  mappedSeriesId?: number;
  mappedSeasonNumber?: number;
  mappedEpisodeInfo?: { id: number }[];
  mappedEpisodeNumbers?: number[];
  rejections?: string[];
  rejected: boolean;
  downloadAllowed: boolean;
}
interface Page<T> {
  records: T[];
  totalRecords: number;
}

// These operations deliberately bypass rolling caches and never log upstream payloads.
export default class SonarrDownloadsAPI extends SonarrAPI {
  constructor(options: { url: string; apiKey: string }) {
    super(options);
    this.axios.defaults.maxContentLength = 4 * 1024 * 1024;
    this.axios.defaults.timeout = 15000;
  }
  async downloadSeries(tvdbId: number): Promise<SonarrSeries[]> {
    return (
      await this.axios.get<SonarrSeries[]>('/series', { params: { tvdbId } })
    ).data.filter((s) => s.tvdbId === tvdbId);
  }
  async downloadEpisodes(seriesId: number): Promise<EpisodeResult[]> {
    return (
      await this.axios.get<EpisodeResult[]>('/episode', {
        params: { seriesId },
        timeout: 15000,
      })
    ).data;
  }
  async downloadQueue() {
    const { data } = await this.axios.get<Page<SonarrDownloadQueue>>('/queue', {
      params: { page: 1, pageSize: 1000 },
      timeout: 15000,
    });
    return {
      records: data.records,
      truncated: data.totalRecords > data.records.length,
    };
  }
  async downloadHistory(seriesId: number, episodeIds: Set<number>) {
    const records: SonarrDownloadHistory[] = [];
    let totalRecords = 0;
    let scanned = 0;
    // Some Sonarr versions ignore seriesId. Filter locally, and disclose the scan limit.
    for (let page = 1; page <= 3; page++) {
      const { data } = await this.axios.get<Page<SonarrDownloadHistory>>(
        '/history',
        {
          params: {
            seriesId,
            page,
            pageSize: 100,
            sortKey: 'date',
            sortDirection: 'descending',
          },
          timeout: 10000,
        }
      );
      totalRecords = data.totalRecords;
      scanned += data.records.length;
      records.push(
        ...data.records.filter(
          (r) =>
            episodeIds.has(r.episodeId) &&
            (r.seriesId === undefined || r.seriesId === seriesId)
        )
      );
      if (scanned >= totalRecords || !data.records.length) break;
    }
    return { records, truncated: scanned < totalRecords };
  }
  async downloadReleases(
    seriesId: number,
    seasonNumber: number,
    episodeId?: number
  ) {
    return (
      await this.axios.get<SonarrRelease[]>('/release', {
        params:
          episodeId === undefined ? { seriesId, seasonNumber } : { episodeId },
        timeout: 45000,
      })
    ).data;
  }
  async grabDownload(release: SonarrRelease) {
    // The guid/indexer pair refers to Sonarr's own search cache; never accept a URL or a remote release body.
    await this.axios.post(
      '/release',
      { guid: release.guid, indexerId: release.indexerId },
      { timeout: 15000 }
    );
  }
}
