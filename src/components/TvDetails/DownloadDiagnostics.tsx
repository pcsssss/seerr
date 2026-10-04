import Button from '@app/components/Common/Button';
import Modal from '@app/components/Common/Modal';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import type {
  TvDownloadDiagnostics,
  TvDownloadRelease,
  TvDownloadSearch,
} from '@server/interfaces/api/tvDownloadInterfaces';
import axios from 'axios';
import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.TvDetails.DownloadDiagnostics', {
  title: 'Download details',
  open: 'Show download details',
  close: 'Hide download details',
  version: 'Version',
  standard: 'Standard',
  fourk: '4K',
  request: 'Request mapping',
  current: 'Current media mapping',
  requestnumber: 'Request #{id}',
  season: 'Season',
  seasonnumber: 'Season {number}',
  summary: '{files} of {total} episodes imported',
  server: 'Sonarr: {name}',
  refresh: 'Refresh progress',
  loading: 'Loading Sonarr status…',
  failure:
    'Could not load Sonarr status. Check the server mapping and try refreshing.',
  unavailable:
    'Sonarr could not complete the operation. Refresh progress before retrying a download.',
  search: 'Find sources',
  picker: 'Sources for {target}',
  retry: 'Search again',
  dismiss: 'Close',
  back: 'Back to sources',
  expired:
    'These sources have expired. Search again before selecting a release.',
  episodeRelease: 'Episode release',
  episodeSearch: 'Find releases',
  searching: 'Searching indexers…',
  hint: 'Missing means no imported file and no visible queue item. Search explicitly to see current results and rejection reasons; this does not explain earlier searches.',
  empty: 'No episodes found on this Sonarr server.',
  noresults:
    'This search returned no releases. This is not evidence about previous searches.',
  historylimit:
    'History is limited to a scan of the latest 300 records and 10 events per episode. Older events may be omitted.',
  queuelimit:
    'The queue is incomplete. Episodes without visible queue items may still have downloads.',
  warning: 'Sonarr reports a warning or error but supplied no explanation.',
  progress: '{progress}% downloaded',
  imported: 'Imported in Sonarr',
  queued: 'In download queue',
  unmonitored: 'Not monitored',
  unaired: 'Not yet aired',
  missing: 'No file / no visible queue',
  history: 'Recent episode history',
  results: 'Release results for {target}',
  seasonTarget: 'season {number}',
  episodeTarget: 'S{season}E{episode}',
  resultlimit:
    'Only the first 100 results are shown. Search an episode to narrow the results.',
  expires: 'Selection expires at {time}. Search again after expiry.',
  seeders: '{count} seeders',
  unknownseeders: 'Seeders unknown',
  pack: 'Season pack',
  episodes: 'Episodes: {numbers}',
  rejected: 'Rejected by Sonarr',
  accepted: 'No reported rejections',
  duplicate: 'Includes imported or queued episodes',
  notselectable:
    'Not selectable: Sonarr could not safely map or allow this release.',
  select: 'Select release',
  confirm: 'Send this release to Sonarr?',
  confirmbody:
    'Sonarr will manage downloading and import. A season pack may include other episodes. This does not cancel an existing download.',
  rejectconfirm:
    'I have reviewed the rejection reasons and want to download anyway.',
  duplicateconfirm:
    'I understand this may duplicate imported or queued episodes.',
  send: 'Download through Sonarr',
  sending: 'Sending to Sonarr…',
  cancel: 'Cancel',
  sent: 'Release sent to Sonarr. Refresh progress shortly.',
});
interface Props {
  tvId: number;
  requests: { id: number; is4k: boolean }[];
}
function DownloadPanel({ tvId, requests }: Props) {
  const intl = useIntl();
  const text = (key: keyof typeof messages) =>
    intl.formatMessage(messages[key]);
  const [is4k, setIs4k] = useState(false);
  const [requestId, setRequestId] = useState<number>();
  const [season, setSeason] = useState<number>();
  const [search, setSearch] = useState<TvDownloadSearch>();
  const [target, setTarget] = useState<{
    seasonNumber: number;
    episodeId?: number;
    label: string;
  }>();
  const [selected, setSelected] = useState<TvDownloadRelease>();
  const [confirmRejected, setConfirmRejected] = useState(false);
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [expired, setExpired] = useState(false);
  const pendingSearch = useRef<AbortController | undefined>(undefined);
  const busyRef = useRef(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState('');
  const url = `/api/v1/tv/${tvId}/downloads`;
  const { data, error, mutate, isValidating } = useSWR<TvDownloadDiagnostics>(
    `${url}?is4k=${is4k}${requestId === undefined ? '' : `&requestId=${requestId}`}`
  );
  const seasons = [
    ...new Set(data?.episodes.map((e) => e.seasonNumber) ?? []),
  ].sort((a, b) => a - b);
  const seasonNumber =
    season !== undefined && seasons.includes(season) ? season : seasons[0];
  const episodes =
    data?.episodes.filter((e) => e.seasonNumber === seasonNumber) ?? [];
  const reset = () => {
    pendingSearch.current?.abort();
    pendingSearch.current = undefined;
    busyRef.current = false;
    setBusy(false);
    setExpired(false);
    setSearch(undefined);
    setTarget(undefined);
    setSelected(undefined);
    setNotice('');
  };
  useEffect(() => () => pendingSearch.current?.abort(), []);
  useEffect(() => {
    if (!search) return;
    const remaining = Date.parse(search.expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      setExpired(true);
      setSelected(undefined);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const checkExpiry = () => {
      const left = Date.parse(search.expiresAt) - Date.now();
      if (left <= 0) {
        setExpired(true);
        setSelected(undefined);
      } else {
        // Browser timers overflow above ~24 days (including synthetic fixtures).
        timer = setTimeout(checkExpiry, Math.min(left, 2147483647));
      }
    };
    checkExpiry();
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (!target || sending) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (selected) setSelected(undefined);
      else reset();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [target, sending, selected]);
  useEffect(() => {
    const dialog =
      pickerRef.current?.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) return;
    dialog.scrollTop = 0;
    // Switching list/confirmation must not strand focus on a removed button.
    const heading = dialog.querySelector<HTMLElement>('#modal-headline');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }, [selected, search]);
  const operationError = (e: unknown) => {
    // Only our backend's safe message, never axios' URL/config or upstream response.
    setNotice(
      axios.isAxiosError(e) && typeof e.response?.data?.message === 'string'
        ? e.response.data.message
        : text('unavailable')
    );
  };
  const find = async (episodeId?: number) => {
    if (busyRef.current || seasonNumber === undefined) return;
    const ep = episodes.find((e) => e.id === episodeId);
    const nextTarget = {
      seasonNumber,
      episodeId,
      label: ep
        ? intl.formatMessage(messages.episodeTarget, {
            season: seasonNumber,
            episode: ep.episodeNumber,
          })
        : intl.formatMessage(messages.seasonTarget, { number: seasonNumber }),
    };
    reset();
    const controller = new AbortController();
    pendingSearch.current = controller;
    busyRef.current = true;
    setBusy(true);
    setTarget(nextTarget);
    try {
      const response = await axios.post<TvDownloadSearch>(
        `${url}/search`,
        { is4k, requestId, seasonNumber, episodeId },
        { signal: controller.signal, timeout: 120000 }
      );
      if (pendingSearch.current === controller) setSearch(response.data);
    } catch (e) {
      if (pendingSearch.current === controller && !axios.isCancel(e))
        operationError(e);
    } finally {
      if (pendingSearch.current === controller) {
        pendingSearch.current = undefined;
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  const grab = async () => {
    if (busyRef.current || expired || !selected?.token || !target) return;
    if (!search || Date.parse(search.expiresAt) <= Date.now()) {
      setExpired(true);
      setSelected(undefined);
      return;
    }
    busyRef.current = true;
    setSending(true);
    setBusy(true);
    try {
      await axios.post(`${url}/grab`, {
        is4k,
        requestId,
        seasonNumber: target.seasonNumber,
        episodeId: target.episodeId,
        token: selected.token,
        confirmRejected,
        confirmDuplicate,
      });
      setSelected(undefined);
      setSearch(undefined);
      setTarget(undefined);
      setNotice(text('sent'));
      await mutate();
    } catch (e) {
      setSelected(undefined);
      setSearch(undefined);
      operationError(e);
    } finally {
      busyRef.current = false;
      setSending(false);
      setBusy(false);
    }
  };
  return (
    <section
      className="mt-4 space-y-4 rounded-lg bg-gray-800 p-4"
      aria-label={text('title')}
    >
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm">
          {text('version')}
          <select
            disabled={busy}
            value={String(is4k)}
            onChange={(e) => {
              setIs4k(e.target.value === 'true');
              setRequestId(undefined);
              setSeason(undefined);
              reset();
            }}
          >
            <option value="false">{text('standard')}</option>
            <option value="true">{text('fourk')}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {text('request')}
          <select
            disabled={busy}
            value={requestId ?? ''}
            onChange={(e) => {
              setRequestId(e.target.value ? Number(e.target.value) : undefined);
              setSeason(undefined);
              reset();
            }}
          >
            <option value="">{text('current')}</option>
            {requests
              .filter((r) => r.is4k === is4k)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {intl.formatMessage(messages.requestnumber, { id: r.id })}
                </option>
              ))}
          </select>
        </label>
        <Button
          buttonSize="sm"
          disabled={busy || isValidating}
          onClick={() => mutate()}
        >
          {text('refresh')}
        </Button>
      </div>
      {error ? (
        <p role="alert">
          {axios.isAxiosError(error) &&
          typeof error.response?.data?.message === 'string'
            ? error.response.data.message
            : text('failure')}
        </p>
      ) : !data ? (
        <p role="status">{text('loading')}</p>
      ) : (
        <>
          <p className="text-sm text-gray-300">
            {intl.formatMessage(messages.server, { name: data.serverName })}
          </p>
          <p className="max-w-prose text-sm text-gray-300">{text('hint')}</p>
          {data.queueTruncated && (
            <p role="status" className="text-yellow-300">
              {text('queuelimit')}
            </p>
          )}
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1 text-sm">
              {text('season')}
              <select
                disabled={busy || !seasons.length}
                value={seasonNumber ?? ''}
                onChange={(e) => {
                  setSeason(Number(e.target.value));
                  reset();
                }}
              >
                {seasons.map((n) => (
                  <option key={n} value={n}>
                    {intl.formatMessage(messages.seasonnumber, { number: n })}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-sm">
              {intl.formatMessage(messages.summary, {
                files: episodes.filter((e) => e.hasFile).length,
                total: episodes.length,
              })}
            </p>
            <Button
              buttonSize="sm"
              disabled={busy || seasonNumber === undefined}
              onClick={() => find()}
            >
              {text('search')}
            </Button>
          </div>
          {!target && notice && <p role="status">{notice}</p>}
          {!episodes.length && <p>{text('empty')}</p>}
          <ul className="divide-y divide-gray-700">
            {episodes.map((ep) => (
              <li key={ep.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-semibold">
                      {intl.formatMessage(messages.episodeTarget, {
                        season: ep.seasonNumber,
                        episode: ep.episodeNumber,
                      })}{' '}
                      · {ep.title}
                    </span>
                    <p className="text-sm text-gray-300">{text(ep.state)}</p>
                  </div>
                  <Button
                    buttonSize="sm"
                    disabled={busy}
                    onClick={() => find(ep.id)}
                  >
                    {text('episodeSearch')}
                  </Button>
                </div>
                {ep.queue.map((q, index) => (
                  <div key={index} className="mt-2 text-sm">
                    <p className="break-words">
                      {q.title} · {q.status} · {q.trackedStatus} ·{' '}
                      {q.trackedState}
                      {q.progress !== null && (
                        <>
                          {' '}
                          ·{' '}
                          {intl.formatMessage(messages.progress, {
                            progress: q.progress.toFixed(1),
                          })}
                        </>
                      )}
                    </p>
                    {q.messages.length
                      ? q.messages.map((m, i) => (
                          <p key={i} className="text-yellow-300">
                            {m}
                          </p>
                        ))
                      : [q.status, q.trackedStatus].some((s) =>
                          /warning|error/i.test(s)
                        ) && (
                          <p className="text-yellow-300">{text('warning')}</p>
                        )}
                  </div>
                ))}
                {!!ep.history.length && (
                  <details className="mt-2 text-sm text-gray-300">
                    <summary className="cursor-pointer">
                      {text('history')}
                    </summary>
                    <ul className="mt-2 space-y-1">
                      {ep.history.map((h, i) => (
                        <li key={i} className="break-words">
                          {h.date} · {h.eventType} · {h.title}
                          {h.message && (
                            <p className="text-yellow-300">{h.message}</p>
                          )}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
          <p className="text-sm text-gray-300">{text('historylimit')}</p>
        </>
      )}
      <Transition show={!!target}>
        {target && (
          <Modal
            focusTrap
            ref={pickerRef}
            title={
              selected
                ? text('confirm')
                : intl.formatMessage(messages.picker, {
                    target: target.label,
                  })
            }
            onCancel={
              sending
                ? undefined
                : selected
                  ? () => setSelected(undefined)
                  : reset
            }
            cancelText={text(selected ? 'back' : 'dismiss')}
            onOk={selected ? grab : undefined}
            okText={text('send')}
            okDisabled={
              busy ||
              expired ||
              !!(selected?.rejected && !confirmRejected) ||
              !!(selected?.duplicate && !confirmDuplicate)
            }
            onSecondary={
              !selected && !busy ? () => find(target.episodeId) : undefined
            }
            secondaryText={text('retry')}
            backgroundClickable={!busy}
          >
            <div aria-live="polite">
              {busy && (
                <p role="status">{text(sending ? 'sending' : 'searching')}</p>
              )}
              {notice && <p role="alert">{notice}</p>}
            </div>
            {search && !selected && (
              <div className="space-y-3">
                <p className="text-sm text-gray-300">
                  {intl.formatMessage(messages.expires, {
                    time: intl.formatTime(new Date(search.expiresAt)),
                  })}
                </p>
                {expired && (
                  <p role="status" className="text-yellow-300">
                    {text('expired')}
                  </p>
                )}
                {search.truncated && <p>{text('resultlimit')}</p>}
                {!search.releases.length && (
                  <p role="status">{text('noresults')}</p>
                )}
                <ul className="divide-y divide-gray-700">
                  {search.releases.map((release, i) => (
                    <li key={release.token ?? i} className="space-y-2 py-3">
                      <p className="break-words font-semibold">
                        {release.title}
                      </p>
                      <p className="text-sm text-gray-300">
                        {release.indexer} · {release.quality} ·{' '}
                        {(release.size / 1024 ** 3).toFixed(2)} GiB ·{' '}
                        {release.protocol} ·{' '}
                        {release.seeders === null
                          ? text('unknownseeders')
                          : intl.formatMessage(messages.seeders, {
                              count: release.seeders,
                            })}{' '}
                        · {text(release.fullSeason ? 'pack' : 'episodeRelease')}
                      </p>
                      <p className="text-sm">
                        {intl.formatMessage(messages.episodes, {
                          numbers: release.episodeNumbers.join(', '),
                        })}
                      </p>
                      <p
                        className={
                          release.rejected ? 'text-yellow-300' : 'text-gray-300'
                        }
                      >
                        {text(release.rejected ? 'rejected' : 'accepted')}
                      </p>
                      {release.rejections.map((reason, j) => (
                        <p key={j} className="text-sm text-yellow-300">
                          {reason}
                        </p>
                      ))}
                      {release.duplicate && (
                        <p className="text-yellow-300">{text('duplicate')}</p>
                      )}
                      {release.token ? (
                        <Button
                          buttonSize="sm"
                          disabled={busy || expired}
                          onClick={() => {
                            if (Date.parse(search.expiresAt) <= Date.now()) {
                              setExpired(true);
                              return;
                            }
                            setSelected(release);
                            setConfirmDuplicate(false);
                            setConfirmRejected(false);
                          }}
                        >
                          {text('select')}
                        </Button>
                      ) : (
                        <p className="text-sm text-gray-300">
                          {text('notselectable')}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {selected && (
              <>
                <p className="break-words font-semibold">{selected.title}</p>
                <p className="mt-3">{text('confirmbody')}</p>
                {selected.rejections.map((reason, i) => (
                  <p key={i} className="mt-2 text-yellow-300">
                    {reason}
                  </p>
                ))}
                {selected.rejected && (
                  <label className="mt-4 flex items-start gap-2">
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={confirmRejected}
                      onChange={(e) => setConfirmRejected(e.target.checked)}
                    />
                    <span>{text('rejectconfirm')}</span>
                  </label>
                )}
                {selected.duplicate && (
                  <label className="mt-4 flex items-start gap-2">
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={confirmDuplicate}
                      onChange={(e) => setConfirmDuplicate(e.target.checked)}
                    />
                    <span>{text('duplicateconfirm')}</span>
                  </label>
                )}
              </>
            )}
          </Modal>
        )}
      </Transition>
    </section>
  );
}
export default function DownloadDiagnostics(props: Props) {
  const { hasPermission } = useUser();
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  if (!hasPermission(Permission.MANAGE_REQUESTS)) return null;
  return (
    <div className="mt-6">
      <Button onClick={() => setOpen(!open)} aria-expanded={open}>
        {intl.formatMessage(open ? messages.close : messages.open)}
      </Button>
      {open && <DownloadPanel {...props} />}
    </div>
  );
}
