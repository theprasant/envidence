import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  api,
  ApiError,
  clearSessionToken,
  downloadCaseReport,
  readSessionToken,
} from "./api.js";
import type {
  BaselineRecord,
  Bootstrap,
  CaseDetail,
  CaseSummary,
  Change,
  Finding,
  Json,
  JsonValue,
  PublicConfig,
  RollbackPlan,
  RunSummary,
  SnapshotBrief,
  SnapshotDetail,
  SnapshotMeta,
  TimelineEvent,
} from "./types.js";

type Route =
  | { name: "timeline" }
  | { name: "case"; id: string }
  | { name: "runs" }
  | { name: "baselines" }
  | { name: "settings" };

type CaseTab = "findings" | "changes" | "timeline" | "remediation" | "raw";

const CASE_TABS: Array<{ id: CaseTab; label: string }> = [
  { id: "findings", label: "Findings" },
  { id: "changes", label: "All changes" },
  { id: "timeline", label: "Timeline" },
  { id: "remediation", label: "Remediation" },
  { id: "raw", label: "Raw evidence" },
];

export function App(): ReactElement {
  const [token] = useState(() => readSessionToken());
  if (!token) return <TokenGate />;
  return <Dashboard />;
}

function Dashboard(): ReactElement {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailVersion, setDetailVersion] = useState(0);
  const [tab, setTab] = useState<CaseTab>("findings");
  const [plan, setPlan] = useState<RollbackPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const redirected = useRef(false);

  const navigate = useCallback((to: string): void => {
    navigateTo(to);
  }, []);

  useEffect(() => {
    const onHashChange = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const showToast = useCallback((message: string): void => {
    setToast(message);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const loadBoot = useCallback(async (): Promise<void> => {
    setBootError(null);
    try {
      const data = await api<Bootstrap>("/api/bootstrap");
      setBoot(data);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        clearSessionToken();
      }
      setBootError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBoot();
  }, [loadBoot]);

  useEffect(() => {
    if (!boot || redirected.current) return;
    redirected.current = true;
    if (route.name === "timeline" && boot.cases.length > 0) {
      navigate(`/case/${boot.cases[0]?.id}`);
    }
  }, [boot, navigate, route.name]);

  const caseId = route.name === "case" ? route.id : null;

  useEffect(() => {
    if (!caseId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    setTab("findings");
    setPlan(null);
    setPlanError(null);
    api<CaseDetail>(`/api/cases/${encodeURIComponent(caseId)}`)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch((error: unknown) => {
        if (!cancelled) setDetailError(errorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [caseId, detailVersion]);

  const refresh = useCallback((): void => {
    setRefreshing(true);
    setDetailVersion((value) => value + 1);
    void loadBoot().finally(() => {
      window.setTimeout(() => setRefreshing(false), 350);
    });
  }, [loadBoot]);

  const loadPlan = useCallback(async (): Promise<void> => {
    if (!detail) return;
    setPlanLoading(true);
    setPlanError(null);
    try {
      const data = await api<{ plan: RollbackPlan }>(
        `/api/rollback/plan?case=${encodeURIComponent(detail.case.id)}`,
      );
      setPlan(data.plan);
    } catch (error) {
      setPlanError(errorMessage(error));
    } finally {
      setPlanLoading(false);
    }
  }, [detail]);

  useEffect(() => {
    if (tab === "remediation" && detail && !plan && !planLoading && !planError) {
      void loadPlan();
    }
  }, [detail, loadPlan, plan, planError, planLoading, tab]);

  const copy = useCallback(
    async (text: string, label = "Copied to clipboard"): Promise<void> => {
      try {
        await navigator.clipboard.writeText(text);
        showToast(label);
      } catch {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
        showToast(label);
      }
    },
    [showToast],
  );

  const exportReport = useCallback(
    async (redaction: "standard" | "strict" | "none" = "standard"): Promise<void> => {
      if (!detail) return;
      try {
        await downloadCaseReport(detail.case.id, redaction);
        showToast("Case file exported");
      } catch (error) {
        showToast(errorMessage(error));
      }
    },
    [detail, showToast],
  );

  const title = routeTitle(route);
  const alreadyOnCase = route.name === "case" ? route.id : null;

  if (!boot) {
    return (
      <div className="app-shell">
        <div className="workspace">
          <main className="content">
            {bootError ? (
              <ErrorState
                title="Could not open the evidence store"
                message={bootError}
                action={
                  <button className="btn primary" onClick={() => void loadBoot()}>
                    Retry
                  </button>
                }
              />
            ) : (
              <LoadingState />
            )}
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar
        boot={boot}
        route={route}
        navigate={navigate}
        activeCaseId={alreadyOnCase}
      />
      <div className="workspace">
        <Topbar
          title={title}
          subtitle={boot ? storeSubtitle(boot) : "Local machine evidence"}
          refreshing={refreshing}
          onRefresh={refresh}
          onExport={detail ? () => void exportReport("standard") : null}
        />
        <main className="content">
          {loading ? (
            <LoadingState />
          ) : bootError ? (
            <ErrorState
              title="Could not open the evidence store"
              message={bootError}
              action={
                <button className="btn primary" onClick={() => void loadBoot()}>
                  Retry
                </button>
              }
            />
          ) : (
            <>
              {route.name === "timeline" ? (
                <TimelinePage
                  boot={boot}
                  navigate={navigate}
                  onSnapshot={setSnapshotId}
                />
              ) : null}
              {route.name === "case" ? (
                <CasePage
                  detail={detail}
                  loading={detailLoading}
                  error={detailError}
                  tab={tab}
                  onTab={setTab}
                  plan={plan}
                  planLoading={planLoading}
                  planError={planError}
                  onLoadPlan={() => void loadPlan()}
                  onCopy={copy}
                  onExport={exportReport}
                  onSnapshot={setSnapshotId}
                  navigate={navigate}
                />
              ) : null}
              {route.name === "runs" ? (
                <RunsPage boot={boot} navigate={navigate} />
              ) : null}
              {route.name === "baselines" ? (
                <BaselinesPage boot={boot} onSnapshot={setSnapshotId} />
              ) : null}
              {route.name === "settings" ? <SettingsPage boot={boot} /> : null}
            </>
          )}
        </main>
      </div>
      {snapshotId ? (
        <SnapshotDrawer id={snapshotId} onClose={() => setSnapshotId(null)} />
      ) : null}
      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}

function TokenGate(): ReactElement {
  return (
    <div className="token-gate">
      <div className="token-card">
        <div className="brand-mark large">E</div>
        <div className="eyebrow">Envidence · local dashboard</div>
        <h1>This session needs its token.</h1>
        <p>
          The dashboard is served on <code>127.0.0.1</code> and every API request is
          protected by a one-time session token. Open the link printed by{" "}
          <code>evd ui</code>.
        </p>
        <pre className="command">evd ui --demo</pre>
        <p className="muted">
          The token travels in the URL fragment, never to a third party. Envidence does
          not make network calls, collect telemetry, or use an LLM.
        </p>
      </div>
    </div>
  );
}

function Sidebar(props: {
  boot: Bootstrap | null;
  route: Route;
  navigate: (to: string) => void;
  activeCaseId: string | null;
}): ReactElement {
  const { boot, route, navigate, activeCaseId } = props;
  const openCases = boot?.cases.filter((record) => record.status === "open") ?? [];
  const recentCases = (openCases.length > 0 ? openCases : boot?.cases ?? []).slice(0, 9);
  const nav = [
    { id: "timeline", label: "Timeline", icon: "timeline", to: "/timeline" },
    { id: "runs", label: "Runs", icon: "runs", to: "/runs" },
    { id: "baselines", label: "Baselines", icon: "baseline", to: "/baselines" },
    { id: "settings", label: "Settings", icon: "settings", to: "/settings" },
  ] as const;

  return (
    <aside className="sidebar">
      <button className="brand" onClick={() => navigate("/timeline")}>
        <span className="brand-mark">E</span>
        <span>
          <strong>ENVIDENCE</strong>
          <small>machine case files</small>
        </span>
      </button>
      <p className="tagline">It worked yesterday. Envidence knows what changed.</p>

      <nav className="nav" aria-label="Views">
        {nav.map((item) => (
          <button
            key={item.id}
            className={`nav-item ${route.name === item.id ? "active" : ""}`}
            onClick={() => navigate(item.to)}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
            {item.id === "runs" && boot ? <em>{boot.runs.length}</em> : null}
            {item.id === "baselines" && boot?.store.activeBaseline ? <i className="pin" /> : null}
          </button>
        ))}
      </nav>

      <div className="sidebar-section">
        <div className="section-label">
          <span>Cases</span>
          <span className="count">{boot?.cases.length ?? 0}</span>
        </div>
        {recentCases.length > 0 ? (
          <div className="case-list">
            {recentCases.map((record) => (
              <CaseListItem
                key={record.id}
                record={record}
                active={activeCaseId === record.id}
                onClick={() => navigate(`/case/${record.id}`)}
              />
            ))}
          </div>
        ) : (
          <p className="sidebar-empty">No cases yet. Run a command with <code>evd watch</code>.</p>
        )}
      </div>

      <div className="sidebar-foot">
        <div className="local-dot"><span /> local only</div>
        {boot ? (
          <div className="store-meta">
            <span>{boot.store.stats.snapshots} snapshots</span>
            <span>{boot.store.stats.runs} runs</span>
            <span>{formatBytes(boot.store.stats.bytes)}</span>
          </div>
        ) : null}
        <div className="version">v{boot?.product.version ?? "0.1.0"} · schema 1</div>
      </div>
    </aside>
  );
}

function CaseListItem(props: {
  record: CaseSummary;
  active: boolean;
  onClick: () => void;
}): ReactElement {
  const { record, active, onClick } = props;
  return (
    <button className={`case-item ${active ? "active" : ""}`} onClick={onClick}>
      <span className={`status-dot ${record.status}`} />
      <span className="case-item-main">
        <span className="case-item-top">
          <code>{record.id.replace("CASE-", "")}</code>
          <span>{formatAgo(record.createdAt)}</span>
        </span>
        <span className="case-item-title">{record.title}</span>
        <span className="case-item-meta">
          {record.topFinding ? (
            <>
              <span className={`score-dot ${confidenceClass(record.topFinding.confidence)}`} />
              {record.topFinding.score}/100 · {record.findingCount} finding
              {record.findingCount === 1 ? "" : "s"}
            </>
          ) : (
            "No ranked finding"
          )}
        </span>
      </span>
    </button>
  );
}

function Topbar(props: {
  title: string;
  subtitle: string;
  refreshing: boolean;
  onRefresh: () => void;
  onExport: (() => void) | null;
}): ReactElement {
  return (
    <header className="topbar">
      <div>
        <div className="breadcrumb">ENVIDENCE / {props.title.toUpperCase()}</div>
        <h2>{props.title}</h2>
        <p className="muted">{props.subtitle}</p>
      </div>
      <div className="topbar-actions">
        <span className="local-pill"><span /> LOCAL ONLY</span>
        {props.onExport ? (
          <button className="btn ghost" onClick={props.onExport}>
            <Icon name="download" /> Export
          </button>
        ) : null}
        <button
          className={`btn ghost icon-only ${props.refreshing ? "spinning" : ""}`}
          onClick={props.onRefresh}
          aria-label="Refresh evidence"
          title="Refresh evidence"
        >
          <Icon name="refresh" />
        </button>
      </div>
    </header>
  );
}

function TimelinePage(props: {
  boot: Bootstrap;
  navigate: (to: string) => void;
  onSnapshot: (id: string) => void;
}): ReactElement {
  const { boot, navigate, onSnapshot } = props;
  const events = boot.events;
  const open = boot.cases.filter((record) => record.status === "open").length;
  return (
    <div className="page">
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">Chain of custody</div>
          <h1>Every change leaves a trace.</h1>
          <p>
            Snapshots, runs, and cases from this machine. Read-only evidence, kept
            locally, ordered by when it happened.
          </p>
          <div className="hero-actions">
            <button className="btn primary" onClick={() => navigate("/runs")}>
              Browse runs <Icon name="arrow" />
            </button>
            <button className="btn ghost" onClick={() => navigate("/settings")}>
              What is collected?
            </button>
          </div>
        </div>
        <div className="hero-stats">
          <HeroStat label="Snapshots" value={boot.store.stats.snapshots} />
          <HeroStat label="Runs" value={boot.store.stats.runs} />
          <HeroStat label="Cases" value={boot.store.stats.cases} />
          <HeroStat label="Open" value={open} tone={open > 0 ? "coral" : "teal"} />
        </div>
      </section>

      <div className="split-heading">
        <div>
          <div className="eyebrow">Timeline</div>
          <h2>What happened, in order</h2>
        </div>
        <div className="legend">
          <span><i className="legend-dot teal" /> successful run</span>
          <span><i className="legend-dot coral" /> failed run</span>
          <span><i className="legend-dot amber" /> baseline</span>
        </div>
      </div>

      {events.length === 0 ? (
        <EmptyState
          title="The black box is empty"
          body="Create a baseline, capture a snapshot, or record a command. Envidence will only use local machine state."
          command="evd snap && evd watch -- npm test"
        />
      ) : (
        <ol className="timeline-list">
          {events.map((event, index) => {
            const previous = events[index - 1];
            const day = dayLabel(event.at);
            const showDay = !previous || dayLabel(previous.at) !== day;
            return (
              <Fragment key={`${event.type}-${event.id}-${index}`}>
                {showDay ? <li className="timeline-day">{day}</li> : null}
                <TimelineRow
                  event={event}
                  navigate={navigate}
                  onSnapshot={onSnapshot}
                />
              </Fragment>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function TimelineRow(props: {
  event: TimelineEvent;
  navigate: (to: string) => void;
  onSnapshot: (id: string) => void;
}): ReactElement {
  const { event, navigate, onSnapshot } = props;
  if (event.type === "case") {
    return (
      <li className="timeline-row case-event">
        <button className="timeline-marker" onClick={() => navigate(`/case/${event.id}`)}>
          <Icon name="case" />
        </button>
        <button className="timeline-card" onClick={() => navigate(`/case/${event.id}`)}>
          <span className="timeline-top">
            <span className="event-type">CASE</span>
            <code>{event.id}</code>
            <span className={`badge ${event.status === "open" ? "coral" : "muted-badge"}`}>
              {event.status}
            </span>
            <time>{formatAgo(event.at)}</time>
          </span>
          <strong>{event.title}</strong>
          <span className="timeline-detail">
            {event.topFinding ?? "No ranked hypothesis"} · {event.score ?? 0}/100
          </span>
        </button>
      </li>
    );
  }
  if (event.type === "run") {
    const failed = event.exitCode !== 0;
    return (
      <li className={`timeline-row ${failed ? "failed" : "success"}`}>
        <span className={`timeline-marker ${failed ? "coral" : "teal"}`}>
          <Icon name="run" />
        </span>
        <button
          className="timeline-card"
          onClick={() => {
            if (event.caseId) navigate(`/case/${event.caseId}`);
          }}
          disabled={!event.caseId}
        >
          <span className="timeline-top">
            <span className="event-type">RUN</span>
            <code>{event.id}</code>
            <span className={`exit ${failed ? "failed" : "ok"}`}>
              exit {event.exitCode ?? "?"}
            </span>
            <time>{formatAgo(event.at)}</time>
          </span>
          <strong className="command">{event.command}</strong>
          <span className="timeline-detail">
            {event.durationMs ? formatDuration(event.durationMs) : "duration unknown"}
            {event.caseId ? ` · case ${event.caseId}` : " · no case opened"}
          </span>
        </button>
      </li>
    );
  }
  if (event.type === "baseline") {
    return (
      <li className="timeline-row baseline-event">
        <span className="timeline-marker amber"><Icon name="baseline" /></span>
        <div className="timeline-card">
          <span className="timeline-top">
            <span className="event-type">BASELINE</span>
            <span className={`badge ${event.active ? "amber-badge" : "muted-badge"}`}>
              {event.active ? "active" : "inactive"}
            </span>
            <time>{formatAgo(event.at)}</time>
          </span>
          <strong>{event.label || "Known good"}</strong>
          <span className="timeline-detail">{event.snapshotId}</span>
        </div>
      </li>
    );
  }
  return (
    <li className="timeline-row">
      <button className="timeline-marker" onClick={() => onSnapshot(event.id)}>
        <Icon name="snap" />
      </button>
      <button className="timeline-card" onClick={() => onSnapshot(event.id)}>
        <span className="timeline-top">
          <span className="event-type">SNAPSHOT</span>
          <code>{event.id}</code>
          <span className="badge muted-badge">{event.profile}</span>
          <time>{formatAgo(event.at)}</time>
        </span>
        <strong>{event.label || `${capitalize(event.trigger ?? "capture")} snapshot`}</strong>
        <span className="timeline-detail">
          {event.warnings ? `${event.warnings} collector warning${event.warnings === 1 ? "" : "s"}` : "collectors clean"}
        </span>
      </button>
    </li>
  );
}

function CasePage(props: {
  detail: CaseDetail | null;
  loading: boolean;
  error: string | null;
  tab: CaseTab;
  onTab: (tab: CaseTab) => void;
  plan: RollbackPlan | null;
  planLoading: boolean;
  planError: string | null;
  onLoadPlan: () => void;
  onCopy: (text: string, label?: string) => Promise<void>;
  onExport: (redaction?: "standard" | "strict" | "none") => Promise<void>;
  onSnapshot: (id: string) => void;
  navigate: (to: string) => void;
}): ReactElement {
  const {
    detail,
    loading,
    error,
    tab,
    onTab,
    plan,
    planLoading,
    planError,
    onLoadPlan,
    onCopy,
    onExport,
    onSnapshot,
    navigate,
  } = props;

  if (loading) return <LoadingState label="Opening case file" />;
  if (error) return <ErrorState title="Could not open this case" message={error} />;
  if (!detail) return <EmptyState title="Case not found" body="Choose a case from the timeline." />;

  const { case: record, run, project, host, findings } = detail;
  const top = findings[0] ?? null;
  const observed = detail.changes.filter((change) => change.origin === "observed-during").length;
  const preExisting = detail.changes.filter((change) => change.origin === "pre-existing").length;

  return (
    <div className="page case-page">
      <section className="case-head">
        <div className="case-stamp">CASE FILE</div>
        <div className="case-title-block">
          <div className="case-kicker">
            <span className={`badge ${record.status === "open" ? "coral" : "muted-badge"}`}>
              {record.status}
            </span>
            <code>{record.id}</code>
            <span className="muted">opened {formatAgo(record.createdAt)}</span>
            {record.closedAt ? <span className="muted">· closed {formatAgo(record.closedAt)}</span> : null}
          </div>
          <h1>{record.title}</h1>
          <div className="command-line">
            <span className="prompt">$</span>
            <code>{run.command}</code>
            <span className={`exit ${run.exitCode === 0 ? "ok" : "failed"}`}>
              exit {run.exitCode ?? "?"}
            </span>
          </div>
          <p className="case-summary">{record.summary}</p>
        </div>
        <div className="case-head-actions">
          <button className="btn primary" onClick={() => void onExport("standard")}>
            <Icon name="download" /> Export case file
          </button>
          <button className="btn ghost" onClick={() => onTab("remediation")}>
            <Icon name="play" /> Preview fixes
          </button>
        </div>
      </section>

      <div className="summary-grid">
        <SummaryCell
          label="Tracked changes"
          value={String(detail.changes.length)}
          note={`${observed} observed during · ${preExisting} pre-existing`}
        />
        <SummaryCell
          label="Reference"
          value={detail.reference.id}
          note={`${detail.referenceSource.replace("-", " ")} · ${formatAgo(detail.reference.createdAt)}`}
        />
        <SummaryCell
          label="Project"
          value={project ? basename(project.root) : "unknown"}
          note={project ? `${project.kind} · ${project.git?.branch ?? "no git"}` : "no project context"}
        />
        <SummaryCell
          label="Fingerprint"
          value={detail.fingerprint.slice(0, 20)}
          note={host.hostname}
          mono
        />
      </div>

      <section className={`top-suspect ${top ? confidenceClass(top.confidence) : "empty"}`}>
        <div className="top-suspect-main">
          <div className="eyebrow">Top suspect · evidence, not proof</div>
          <h2>{top?.title ?? "No ranked hypothesis"}</h2>
          <p>
            {top?.description ??
              "The command failed, but no relevant machine change was observed during its window. Check Git, the lockfile, network services, and credentials next."}
          </p>
          {top ? (
            <div className="top-suspect-fix">
              <span className="muted">Suggested fix</span>
              <code>{top.fix}</code>
              <button className="mini-btn" onClick={() => void onCopy(top.fix, "Fix copied")}>
                <Icon name="copy" /> copy
              </button>
            </div>
          ) : null}
        </div>
        <div className="confidence-block">
          <ConfidenceRing confidence={top?.confidence ?? "low"} score={top?.score ?? 0} />
          <span>{top ? `${top.score}/100 · ${top.confidence} confidence` : "no score"}</span>
        </div>
      </section>

      <div className="tabs" role="tablist" aria-label="Case sections">
        {CASE_TABS.map((item) => (
          <button
            key={item.id}
            className={`tab ${tab === item.id ? "active" : ""}`}
            onClick={() => onTab(item.id)}
            role="tab"
            aria-selected={tab === item.id}
          >
            {item.label}
            {item.id === "findings" ? <em>{findings.length}</em> : null}
            {item.id === "changes" ? <em>{detail.changes.length}</em> : null}
          </button>
        ))}
        <div className="tabs-spacer" />
        <button className="mini-btn" onClick={() => navigate("/timeline")}>
          back to timeline
        </button>
      </div>

      {tab === "findings" ? (
        <FindingsTab
          findings={findings}
          onCopy={onCopy}
          onRemediate={() => onTab("remediation")}
        />
      ) : null}
      {tab === "changes" ? (
        <ChangesTab changes={detail.changes} onCopy={onCopy} />
      ) : null}
      {tab === "timeline" ? (
        <CaseTimeline detail={detail} onSnapshot={onSnapshot} />
      ) : null}
      {tab === "remediation" ? (
        <RemediationTab
          detail={detail}
          plan={plan}
          loading={planLoading}
          error={planError}
          onLoadPlan={onLoadPlan}
          onCopy={onCopy}
          onExport={onExport}
        />
      ) : null}
      {tab === "raw" ? <RawTab detail={detail} onCopy={onCopy} /> : null}

      <footer className="case-footer">
        <span><Icon name="shield" /> Generated locally. No data left this machine.</span>
        <span className="mono">{detail.fingerprint}</span>
        <span>Envidence · schema 1</span>
      </footer>
    </div>
  );
}

function FindingsTab(props: {
  findings: Finding[];
  onCopy: (text: string, label?: string) => Promise<void>;
  onRemediate: () => void;
}): ReactElement {
  const { findings, onCopy, onRemediate } = props;
  if (findings.length === 0) {
    return (
      <EmptyState
        title="No machine change was strong enough to rank."
        body="A confident 'nothing changed' is still evidence. Check Git, the lockfile, external services, and credentials next."
        command="git status && git diff"
      />
    );
  }
  return (
    <div className="findings-list">
      <div className="section-intro">
        <span className="eyebrow">Ranked hypotheses</span>
        <p>
          Scores combine base weight, project relevance, recency, stderr signals, and
          historical correlation. Evidence is shown so you can verify it.
        </p>
      </div>
      {findings.map((finding) => (
        <FindingsCard
          key={finding.signature}
          finding={finding}
          onCopy={onCopy}
          onRemediate={onRemediate}
        />
      ))}
    </div>
  );
}

function FindingsCard(props: {
  finding: Finding;
  onCopy: (text: string, label?: string) => Promise<void>;
  onRemediate: () => void;
}): ReactElement {
  const { finding, onCopy, onRemediate } = props;
  return (
    <article className={`finding-card ${confidenceClass(finding.confidence)}`}>
      <div className="finding-rank">#{finding.rank}</div>
      <div className="finding-body">
        <div className="finding-head">
          <div>
            <div className="finding-kicker">
              <span className={`badge ${confidenceClass(finding.confidence)}`}>
                {finding.confidence}
              </span>
              <span className="badge muted-badge">{finding.category}</span>
              <span className="mono muted">{finding.rule}</span>
            </div>
            <h3>{finding.title}</h3>
          </div>
          <div className="finding-score">
            <strong>{finding.score}</strong>
            <span>/100</span>
          </div>
        </div>
        <p className="finding-description">{finding.description}</p>
        <div className="evidence-grid">
          <div className="evidence-panel">
            <span className="evidence-label">Before</span>
            <ValueView value={finding.before} />
          </div>
          <div className="evidence-arrow"><Icon name="arrow" /></div>
          <div className="evidence-panel after">
            <span className="evidence-label">After</span>
            <ValueView value={finding.after} />
          </div>
        </div>
        <div className="finding-evidence">
          <span className="evidence-label">Evidence</span>
          <ul>
            {finding.evidence.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div className="finding-fix">
          <code>{finding.fix}</code>
          <button className="mini-btn" onClick={() => void onCopy(finding.fix, "Fix copied")}>
            <Icon name="copy" /> copy
          </button>
          <button className="mini-btn" onClick={onRemediate}>
            <Icon name="play" /> preview fix
          </button>
        </div>
      </div>
    </article>
  );
}

function ChangesTab(props: {
  changes: Change[];
  onCopy: (text: string, label?: string) => Promise<void>;
}): ReactElement {
  const { changes, onCopy } = props;
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [showVolatile, setShowVolatile] = useState(false);
  const categories = useMemo(
    () => ["all", ...Array.from(new Set(changes.map((change) => change.category))).sort()],
    [changes],
  );
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return changes.filter((change) => {
      if (!showVolatile && change.volatile) return false;
      if (category !== "all" && change.category !== category) return false;
      if (!needle) return true;
      return `${change.label} ${change.path} ${change.summary} ${change.category}`
        .toLowerCase()
        .includes(needle);
    });
  }, [category, changes, query, showVolatile]);
  const hidden = changes.length - visible.length;

  if (changes.length === 0) {
    return (
      <EmptyState
        title="No machine differences were observed."
        body="This case is still useful: the failing command did not leave a trace in the tracked machine layer."
      />
    );
  }

  return (
    <div className="changes-panel">
      <div className="changes-toolbar">
        <div className="chips">
          {categories.map((item) => (
            <button
              key={item}
              className={`chip ${category === item ? "active" : ""}`}
              onClick={() => setCategory(item)}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="changes-tools">
          <label className="search">
            <Icon name="search" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter changes"
              aria-label="Filter changes"
            />
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={showVolatile}
              onChange={(event) => setShowVolatile(event.target.checked)}
            />
            <span>volatile</span>
          </label>
        </div>
      </div>
      <div className="change-count">
        {visible.length} of {changes.length} changes
        {hidden > 0 ? <span className="muted"> · {hidden} hidden by filters</span> : null}
      </div>
      <div className="change-list">
        {visible.map((change) => (
          <ChangeCard key={change.signature} change={change} onCopy={onCopy} />
        ))}
        {visible.length === 0 ? (
          <p className="muted empty-inline">No changes match those filters.</p>
        ) : null}
      </div>
    </div>
  );
}

function ChangeCard(props: {
  change: Change;
  onCopy: (text: string, label?: string) => Promise<void>;
}): ReactElement {
  const { change, onCopy } = props;
  const kind = change.kind === "added" ? "+" : change.kind === "removed" ? "−" : change.kind === "reordered" ? "↕" : "~";
  return (
    <article className={`change-card kind-${change.kind}`}>
      <div className="change-head">
        <span className={`kind-mark ${change.kind}`}>{kind}</span>
        <div className="change-title">
          <strong>{change.label}</strong>
          <code>{change.path}</code>
        </div>
        <span className="badge muted-badge">{change.category}</span>
        <span className={`origin ${change.origin === "observed-during" ? "observed" : "existing"}`}>
          {change.origin}
        </span>
        {change.volatile ? <span className="badge volatile">volatile</span> : null}
      </div>
      <div className="change-values">
        <div>
          <span className="evidence-label">Before</span>
          <ValueView value={change.before} />
        </div>
        <div>
          <span className="evidence-label">After</span>
          <ValueView value={change.after} />
        </div>
        <button
          className="mini-btn copy-value"
          onClick={() =>
            void onCopy(
              `${change.label}: ${formatValue(change.before)} → ${formatValue(change.after)}`,
              "Change copied",
            )
          }
        >
          <Icon name="copy" />
        </button>
      </div>
    </article>
  );
}

function CaseTimeline(props: {
  detail: CaseDetail;
  onSnapshot: (id: string) => void;
}): ReactElement {
  const { detail, onSnapshot } = props;
  const nodes: Array<{
    key: string;
    label: string;
    id: string;
    at: number;
    body: string;
    tone: string;
  }> = [
    {
      key: "reference",
      label: "Reference snapshot",
      id: detail.reference.id,
      at: detail.reference.createdAt,
      body: `${detail.referenceSource.replace("-", " ")} · ${detail.reference.profile}`,
      tone: "reference",
    },
    {
      key: "pre",
      label: "Before command",
      id: detail.pre.id,
      at: detail.pre.createdAt,
      body: `${detail.pre.profile} snapshot`,
      tone: "pre",
    },
    {
      key: "run",
      label: "Command window",
      id: detail.run.id,
      at: detail.run.startedAt,
      body: `${detail.run.command} · exit ${detail.run.exitCode ?? "?"}`,
      tone: "run",
    },
    {
      key: "post",
      label: "After command",
      id: detail.post.id,
      at: detail.post.createdAt,
      body: `${detail.post.profile} snapshot· ${detail.changes.length} changes observed`,
      tone: "post",
    },
  ];
  return (
    <div className="case-timeline">
      <div className="case-timeline-rail">
        {nodes.map((node, index) => (
          <div className={`case-timeline-node ${node.tone}`} key={node.key}>
            <span className="node-index">{String(index + 1).padStart(2, "0")}</span>
            <button className="node-button" onClick={() => onSnapshot(node.id)}>
              <strong>{node.label}</strong>
              <code>{node.id}</code>
              <span>{node.body}</span>
              <time>{formatAgo(node.at)}</time>
            </button>
          </div>
        ))}
      </div>
      <div className="case-timeline-aside">
        <div className="aside-card">
          <span className="eyebrow">Case opened</span>
          <strong>{formatDate(detail.case.createdAt)}</strong>
          <span className="muted">{formatAgo(detail.case.createdAt)}</span>
        </div>
        <div className="aside-card">
          <span className="eyebrow">Run</span>
          <code>{detail.run.id}</code>
          <span className="muted">{formatDuration(detail.run.durationMs)}</span>
        </div>
        <div className="aside-card">
          <span className="eyebrow">Evidence count</span>
          <strong>{detail.changes.length} changes</strong>
          <span className="muted">{detail.nonVolatileChanges.length} relevant</span>
        </div>
      </div>
    </div>
  );
}

function RemediationTab(props: {
  detail: CaseDetail;
  plan: RollbackPlan | null;
  loading: boolean;
  error: string | null;
  onLoadPlan: () => void;
  onCopy: (text: string, label?: string) => Promise<void>;
  onExport: (redaction?: "standard" | "strict" | "none") => Promise<void>;
}): ReactElement {
  const { detail, plan, loading, error, onLoadPlan, onCopy, onExport } = props;
  const [simulated, setSimulated] = useState(false);
  const cli = `evd rollback --case ${detail.case.id} --dry-run --script rollback.ps1`;
  const applyCli = `evd rollback --case ${detail.case.id} --apply --yes`;

  if (loading) return <LoadingState label="Building a dry-run plan" />;
  if (error) {
    return (
      <ErrorState
        title="Could not build a rollback plan"
        message={error}
        action={<button className="btn primary" onClick={onLoadPlan}>Retry</button>}
      />
    );
  }
  if (!plan) {
    return (
      <EmptyState
        title="Preview a reversible plan"
        body="Envidence only changes the machine through explicit actions. Build a dry-run plan first, review preconditions, then apply from the CLI with a safety snapshot."
        action={<button className="btn primary" onClick={onLoadPlan}>Build dry-run plan</button>}
      />
    );
  }

  return (
    <div className="remediation">
      <div className="plan-head">
        <div>
          <span className="eyebrow">Remediation plan · {plan.id}</span>
          <h3>
            {plan.actions.length} automatic action{plan.actions.length === 1 ? "" : "s"}
            {plan.manual.length > 0 ? ` · ${plan.manual.length} manual` : ""}
          </h3>
          <p className="muted">
            Target {plan.targetSnapshot ?? "none"} → current {plan.currentSnapshot ?? "none"}.
            Preconditions are checked again immediately before apply.
          </p>
        </div>
        <div className="plan-actions">
          <button className="btn ghost" onClick={() => setSimulated((value) => !value)}>
            <Icon name="play" /> {simulated ? "Hide simulation" : "Simulate plan"}
          </button>
          <button className="btn ghost" onClick={() => void onCopy(cli, "CLI copied")}>
            <Icon name="copy" /> Copy CLI
          </button>
        </div>
      </div>

      {simulated ? (
        <div className="simulation-banner">
          <strong>Simulation only.</strong> No environment was changed. Every step is marked
          as it would be applied; real apply is intentionally left to the CLI.
        </div>
      ) : null}

      <div className="plan-grid">
        <div className="plan-actions-list">
          {plan.actions.length === 0 ? (
            <p className="muted">No automatic actions are available for this selection.</p>
          ) : (
            plan.actions.map((action, index) => (
              <article className={`plan-action ${simulated ? "simulated" : ""}`} key={action.id}>
                <div className="plan-action-index">{String(index + 1).padStart(2, "0")}</div>
                <div className="plan-action-body">
                  <div className="plan-action-head">
                    <strong>{action.title}</strong>
                    <span className="badge muted-badge">{action.category}</span>
                    {action.requiresAdmin ? <span className="badge amber-badge">admin</span> : null}
                    {!action.reversible ? <span className="badge coral">not reversible</span> : null}
                  </div>
                  <p className="muted">{action.description}</p>
                  <div className="plan-values">
                    <div><span className="evidence-label">Before</span><ValueView value={action.payload.from} /></div>
                    <div><span className="evidence-label">After</span><ValueView value={action.payload.to} /></div>
                  </div>
                </div>
                {simulated ? <span className="simulated-check">✓</span> : null}
              </article>
            ))
          )}
          {plan.manual.length > 0 ? (
            <div className="manual-steps">
              <h4>Manual steps</h4>
              <ol>{plan.manual.map((step) => <li key={step}>{step}</li>)}</ol>
            </div>
          ) : null}
        </div>

        <aside className="plan-aside">
          <div className="aside-card">
            <span className="eyebrow">Safety</span>
            <strong>Dry run by default</strong>
            <p className="muted">
              Apply takes a full safety snapshot first, checks every precondition again, and
              writes an audit record. Undo is available immediately after.
            </p>
            <button className="btn ghost full" onClick={() => void onCopy(applyCli, "Apply command copied")}>
              Copy apply command
            </button>
          </div>
          <div className="aside-card">
            <span className="eyebrow">Share</span>
            <strong>Case file</strong>
            <p className="muted">Self-contained HTML with redaction. No network assets.</p>
            <button className="btn ghost full" onClick={() => void onExport("standard")}>
              <Icon name="download" /> Standard redaction
            </button>
            <button className="btn ghost full" onClick={() => void onExport("strict")}>
              <Icon name="download" /> Strict redaction
            </button>
          </div>
          {plan.warnings.length > 0 ? (
            <div className="aside-card warning-card">
              <span className="eyebrow">Warnings</span>
              <ul>{plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function RawTab(props: {
  detail: CaseDetail;
  onCopy: (text: string, label?: string) => Promise<void>;
}): ReactElement {
  const json = JSON.stringify(props.detail, null, 2);
  return (
    <div className="raw-panel">
      <div className="raw-head">
        <div>
          <span className="eyebrow">Raw evidence</span>
          <p className="muted">The local case record, exactly as the store returns it.</p>
        </div>
        <button className="btn ghost" onClick={() => void props.onCopy(json, "Raw JSON copied")}>
          <Icon name="copy" /> Copy JSON
        </button>
      </div>
      <pre className="raw-json">{json}</pre>
    </div>
  );
}

function RunsPage(props: {
  boot: Bootstrap;
  navigate: (to: string) => void;
}): ReactElement {
  const { boot, navigate } = props;
  const [query, setQuery] = useState("");
  const runs = boot.runs.filter((run) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return `${run.command} ${run.id} ${run.caseId ?? ""} ${run.caseTitle ?? ""}`
      .toLowerCase()
      .includes(needle);
  });
  const failures = boot.runs.filter((run) => run.exitCode !== 0).length;
  return (
    <div className="page">
      <section className="page-heading">
        <div>
          <div className="eyebrow">Command history</div>
          <h1>Runs</h1>
          <p>Every watched command, its exit code, duration, and case linkage.</p>
        </div>
        <div className="heading-stats">
          <span><strong>{boot.runs.length}</strong> total</span>
          <span className="coral-text"><strong>{failures}</strong> failed</span>
          <span className="teal-text"><strong>{boot.runs.length - failures}</strong> passed</span>
        </div>
      </section>
      <label className="search wide">
        <Icon name="search" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter commands, IDs, or case titles"
        />
      </label>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Command</th>
              <th>Exit</th>
              <th>Duration</th>
              <th>When</th>
              <th>Case</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id} className={run.exitCode !== 0 ? "row-failed" : ""}>
                <td><code>{run.id}</code></td>
                <td className="command-cell">
                  <span className="command">{run.command}</span>
                  <span className="muted truncate">{run.cwd}</span>
                </td>
                <td>
                  <span className={`exit ${run.exitCode === 0 ? "ok" : "failed"}`}>
                    {run.exitCode ?? "?"}
                  </span>
                </td>
                <td>{formatDuration(run.durationMs)}</td>
                <td>{formatAgo(run.startedAt)}</td>
                <td>
                  {run.caseId ? (
                    <button className="link-btn" onClick={() => navigate(`/case/${run.caseId}`)}>
                      {run.caseId.replace("CASE-", "")}
                    </button>
                  ) : (
                    <span className="muted">none</span>
                  )}
                </td>
              </tr>
            ))}
            {runs.length === 0 ? (
              <tr><td colSpan={6} className="muted center">No runs match this filter.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BaselinesPage(props: {
  boot: Bootstrap;
  onSnapshot: (id: string) => void;
}): ReactElement {
  const { boot, onSnapshot } = props;
  const active = boot.store.activeBaseline;
  return (
    <div className="page">
      <section className="page-heading">
        <div>
          <div className="eyebrow">Known good</div>
          <h1>Baselines</h1>
          <p>Baselines anchor the “last time this machine was healthy” reference.</p>
        </div>
        <div className="heading-stats">
          <span><strong>{boot.baselines.length}</strong> baselines</span>
          <span className={active ? "amber-text" : "muted"}><strong>{active ? "active" : "none"}</strong></span>
        </div>
      </section>

      {active ? (
        <section className="baseline-hero">
          <div className="baseline-pin"><Icon name="baseline" /></div>
          <div>
            <span className="eyebrow">Active baseline</span>
            <h2>{active.label || "Known good"}</h2>
            <p className="muted">
              {active.snapshotId} · accepted {formatAgo(active.createdAt)}
            </p>
          </div>
          <div className="baseline-drift">
            <span className="eyebrow">Drift to latest</span>
            <strong className={boot.store.baselineDrift === 0 ? "teal-text" : "amber-text"}>
              {boot.store.baselineDrift === null ? "unknown" : `${boot.store.baselineDrift} facts`}
            </strong>
            <span className="muted">
              {boot.store.baselineDrift === 0 ? "machine matches baseline" : "differences are evidence, not errors"}
            </span>
          </div>
          <button className="btn ghost" onClick={() => onSnapshot(active.snapshotId)}>
            Inspect snapshot
          </button>
        </section>
      ) : (
        <EmptyState
          title="No baseline yet"
          body="Mark the last known good snapshot as the reference for future cases."
          command={'evd baseline set latest --label "Known good"'}
        />
      )}

      <div className="split-heading">
        <div><div className="eyebrow">History</div><h2>Baseline pins</h2></div>
        <code className="muted">evd baseline set latest</code>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>Baseline</th><th>Label</th><th>Snapshot</th><th>Accepted</th><th>State</th></tr></thead>
          <tbody>
            {boot.baselines.map((baseline) => (
              <tr key={baseline.id}>
                <td><code>{baseline.id}</code></td>
                <td>{baseline.label}</td>
                <td>
                  <button className="link-btn" onClick={() => onSnapshot(baseline.snapshotId)}>
                    {baseline.snapshotId}
                  </button>
                </td>
                <td>{formatAgo(baseline.createdAt)}</td>
                <td><span className={`badge ${baseline.active ? "amber-badge" : "muted-badge"}`}>{baseline.active ? "active" : "inactive"}</span></td>
              </tr>
            ))}
            {boot.baselines.length === 0 ? (
              <tr><td colSpan={5} className="muted center">No baselines recorded.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SettingsPage(props: { boot: Bootstrap }): ReactElement {
  const config = props.boot.store.config;
  return (
    <div className="page">
      <section className="page-heading">
        <div>
          <div className="eyebrow">Transparent by default</div>
          <h1>Settings</h1>
          <p>Exactly what Envidence collects, where it lives, and what it never stores.</p>
        </div>
        <span className="local-pill"><span /> local only</span>
      </section>

      <div className="settings-grid">
        <SettingsCard title="Store">
          <SettingRow label="Path" value={props.boot.store.home} mono />
          <SettingRow label="Schema" value={String(config.schemaVersion)} />
          <SettingRow label="Snapshots" value={String(props.boot.store.stats.snapshots)} />
          <SettingRow label="Runs" value={String(props.boot.store.stats.runs)} />
          <SettingRow label="Cases" value={String(props.boot.store.stats.cases)} />
          <SettingRow label="Disk usage" value={formatBytes(props.boot.store.stats.bytes)} />
        </SettingsCard>
        <SettingsCard title="Capture">
          <SettingRow label="Profile" value={config.profile} />
          <SettingRow label="Retention" value={`${config.retention.keep} snapshots · ${config.retention.olderThanDays} days`} />
          <SettingRow label="Project scan" value={config.project.scan ? `yes · ${config.project.maxFiles} files` : "no"} />
          <SettingRow label="Redaction" value={config.redaction} />
          <SettingRow label="Secrets" value="values hashed; previews masked" />
          <SettingRow label="Network" value="no calls · no telemetry · no LLM" />
        </SettingsCard>
        <SettingsCard title="Collectors">
          <div className="collector-grid">
            {Object.entries(config.collectors).map(([name, enabled]) => (
              <span key={name} className={`collector ${enabled ? "on" : "off"}`}>
                <i /> {name}
              </span>
            ))}
          </div>
        </SettingsCard>
        <SettingsCard title="Noise rules">
          <SettingRow label="Ephemeral ports" value={config.noise.ephemeralPorts ? "ignored" : "tracked"} />
          <SettingRow label="Ignored services" value={`${config.noise.ignoreServices.length} built in`} />
          <SettingRow label="User ignore patterns" value={String(config.noise.ignore.length)} />
          <SettingRow label="Secret patterns" value={String(config.secretPatternCount)} />
        </SettingsCard>
        <SettingsCard title="Rollback">
          <SettingRow label="Confirmation" value={config.rollback.requireConfirmation ? "required" : "off"} />
          <SettingRow label="Safety snapshot" value={config.rollback.safetySnapshot ? "always before apply" : "off"} />
          <SettingRow label="Default mode" value="dry run" />
          <div className="settings-note">
            Real apply is CLI-only: <code>evd rollback --apply --yes</code>. The dashboard
            previews and simulates plans but does not mutate the environment.
          </div>
        </SettingsCard>
        <SettingsCard title="Dashboard">
          <SettingRow label="Bind" value="127.0.0.1" />
          <SettingRow label="Auth" value="per-session token" />
          <SettingRow label="Config port" value={String(config.ui.port)} />
          <SettingRow label="Salt" value="<redacted>" mono />
          <div className="settings-note">
            Config file: <code>{props.boot.store.home}/config.json</code>
          </div>
        </SettingsCard>
      </div>

      <section className="command-book">
        <div className="eyebrow">Useful commands</div>
        <div className="command-grid">
          <CommandLine command="evd watch -- npm test" label="Record a command" />
          <CommandLine command="evd why --fail-on-findings" label="Explain the latest case" />
          <CommandLine command="evd report --case <id>" label="Export a redacted case file" />
          <CommandLine command="evd rollback --case <id> --dry-run" label="Preview remediation" />
          <CommandLine command="evd baseline set latest" label="Accept a known-good baseline" />
          <CommandLine command="evd doctor" label="Check collector health" />
        </div>
      </section>
    </div>
  );
}

function SettingsCard(props: { title: string; children: ReactNode }): ReactElement {
  return <section className="settings-card"><h3>{props.title}</h3>{props.children}</section>;
}

function SettingRow(props: { label: string; value: string; mono?: boolean }): ReactElement {
  return (
    <div className="setting-row">
      <span>{props.label}</span>
      <code className={props.mono ? "mono" : ""}>{props.value}</code>
    </div>
  );
}

function CommandLine(props: { command: string; label: string }): ReactElement {
  return (
    <div className="command-line-card">
      <span>{props.label}</span>
      <code>{props.command}</code>
    </div>
  );
}

function SnapshotDrawer(props: {
  id: string;
  onClose: () => void;
}): ReactElement {
  const { id, onClose } = props;
  const [detail, setDetail] = useState<SnapshotDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<SnapshotDetail>(`/api/snapshots/${encodeURIComponent(id)}`)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="drawer-layer" role="dialog" aria-modal="true" aria-label="Snapshot detail">
      <button className="drawer-scrim" onClick={onClose} aria-label="Close snapshot" />
      <aside className="drawer">
        <div className="drawer-head">
          <div>
            <span className="eyebrow">Snapshot</span>
            <h2>{id}</h2>
          </div>
          <button className="btn ghost icon-only" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        {loading ? <LoadingState label="Reading snapshot" /> : null}
        {error ? <ErrorState title="Snapshot unavailable" message={error} /> : null}
        {detail ? (
          <>
            <div className="drawer-meta">
              <span><span className="muted">Captured</span> {formatDate(detail.meta.createdAt)}</span>
              <span><span className="muted">Profile</span> {detail.meta.profile}</span>
              <span><span className="muted">Trigger</span> {detail.meta.trigger}</span>
              <span><span className="muted">Warnings</span> {detail.meta.warnings.length}</span>
            </div>
            <div className="drawer-fingerprint"><span className="eyebrow">Fingerprint</span><code>{detail.fingerprint}</code></div>
            <div className="inventory-grid">
              {Object.entries(detail.inventory).map(([name, value]) => (
                <div key={name}><strong>{value}</strong><span>{name}</span></div>
              ))}
            </div>
            {detail.warnings.length > 0 ? (
              <div className="drawer-warnings">
                <span className="eyebrow">Collector warnings</span>
                {detail.warnings.map((warning) => (
                  <p key={`${warning.collector}-${warning.message}`}><strong>{warning.collector}</strong> {warning.message}</p>
                ))}
              </div>
            ) : null}
            <div className="drawer-changes">
              <div className="drawer-section-head">
                <span className="eyebrow">Changes from previous snapshot</span>
                <span className="count">{detail.changes.length}</span>
              </div>
              {detail.changes.length === 0 ? (
                <p className="muted">No changes from {detail.previous?.id ?? "the previous snapshot"}.</p>
              ) : (
                detail.changes.slice(0, 40).map((change) => (
                  <div className="mini-change" key={change.signature}>
                    <span className={`kind-mark ${change.kind}`}>{change.kind === "added" ? "+" : change.kind === "removed" ? "−" : "~"}</span>
                    <div><strong>{change.label}</strong><code>{change.path}</code></div>
                    <span className="badge muted-badge">{change.category}</span>
                  </div>
                ))
              )}
            </div>
          </>
        ) : null}
      </aside>
    </div>
  );
}

function ConfidenceRing(props: {
  confidence: "high" | "medium" | "low";
  score: number;
}): ReactElement {
  const tone = confidenceClass(props.confidence);
  return (
    <div className={`confidence-ring ${tone}`} style={{ "--score": `${Math.max(2, Math.min(100, props.score))}%` } as CSSProperties}>
      <span>{props.score}</span>
      <small>{props.confidence}</small>
    </div>
  );
}

function SummaryCell(props: {
  label: string;
  value: string;
  note: string;
  mono?: boolean;
}): ReactElement {
  return (
    <div className="summary-cell">
      <span>{props.label}</span>
      <strong className={props.mono ? "mono" : ""} title={props.value}>{props.value}</strong>
      <small>{props.note}</small>
    </div>
  );
}

function HeroStat(props: {
  label: string;
  value: number;
  tone?: "teal" | "coral" | "amber";
}): ReactElement {
  return (
    <div className={`hero-stat ${props.tone ?? ""}`}>
      <strong>{props.value}</strong>
      <span>{props.label}</span>
    </div>
  );
}

function ValueView(props: { value: JsonValue | undefined }): ReactElement {
  const text = formatValue(props.value);
  const isLong = text.length > 120 || text.includes("\n");
  if (isLong) {
    return <pre className="value-block">{truncate(text, 700)}</pre>;
  }
  return <code className="value-inline">{text}</code>;
}

function EmptyState(props: {
  title: string;
  body: string;
  command?: string;
  action?: ReactNode;
}): ReactElement {
  return (
    <div className="empty-state">
      <div className="empty-mark"><Icon name="snap" /></div>
      <h3>{props.title}</h3>
      <p>{props.body}</p>
      {props.command ? <pre className="command">{props.command}</pre> : null}
      {props.action ? <div className="empty-action">{props.action}</div> : null}
    </div>
  );
}

function LoadingState(props: { label?: string }): ReactElement {
  return (
    <div className="loading-state">
      <span className="loader" />
      <p>{props.label ?? "Reading local evidence"}</p>
    </div>
  );
}

function ErrorState(props: {
  title: string;
  message: string;
  action?: ReactNode;
}): ReactElement {
  return (
    <div className="error-state">
      <div className="error-mark"><Icon name="alert" /></div>
      <div>
        <h3>{props.title}</h3>
        <p>{props.message}</p>
        {props.action}
      </div>
    </div>
  );
}

function Icon(props: { name: string }): ReactElement {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (props.name) {
    case "timeline":
      return <svg {...common}><path d="M5 3v18" /><circle cx="5" cy="7" r="2" /><circle cx="5" cy="17" r="2" /><path d="M9 7h9M9 17h6" /></svg>;
    case "runs":
      return <svg {...common}><path d="M4 6h16M4 12h16M4 18h16" /><path d="m8 6-2 2 2 2M14 12l-2 2 2 2" /></svg>;
    case "baseline":
      return <svg {...common}><path d="M12 21s6-5.1 6-10a6 6 0 1 0-12 0c0 4.9 6 10 6 10Z" /><circle cx="12" cy="11" r="2.5" /></svg>;
    case "settings":
      return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4v-.2a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L3 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 1.8 14H2v-4h.2a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.9L3 7l2.8-2.8.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 9 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1.1h.2v4h-.2a1.7 1.7 0 0 0-1.6 1Z" /></svg>;
    case "case":
      return <svg {...common}><path d="M4 7h6l2 2h8v10H4Z" /><path d="M4 7V5h6l2 2" /></svg>;
    case "snap":
      return <svg {...common}><path d="M4 8h4l2-3h4l2 3h4v11H4Z" /><circle cx="12" cy="13" r="3.5" /></svg>;
    case "run":
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="m10 8 6 4-6 4Z" /></svg>;
    case "shield":
      return <svg {...common}><path d="M12 3 5 6v5c0 4.7 3 8.2 7 10 4-1.8 7-5.3 7-10V6Z" /><path d="m9 12 2 2 4-5" /></svg>;
    case "refresh":
      return <svg {...common}><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 9A7 7 0 0 1 18.5 7M17.9 15A7 7 0 0 1 5.5 17" /></svg>;
    case "download":
      return <svg {...common}><path d="M12 3v12m0 0 4-4m-4 4-4-4" /><path d="M4 19h16" /></svg>;
    case "copy":
      return <svg {...common}><rect x="8" y="8" width="12" height="12" rx="1.5" /><path d="M16 8V4H4v12h4" /></svg>;
    case "close":
      return <svg {...common}><path d="m5 5 14 14M19 5 5 19" /></svg>;
    case "arrow":
      return <svg {...common}><path d="M4 12h15M13 6l6 6-6 6" /></svg>;
    case "alert":
      return <svg {...common}><path d="M12 3 2 21h20Z" /><path d="M12 9v5M12 17.5v.5" /></svg>;
    case "search":
      return <svg {...common}><circle cx="11" cy="11" r="6.5" /><path d="m16 16 5 5" /></svg>;
    case "play":
      return <svg {...common}><path d="m8 5 11 7-11 7Z" /></svg>;
    default:
      return <svg {...common}><circle cx="12" cy="12" r="8" /></svg>;
  }
}

function parseRoute(hash: string): Route {
  const clean = hash.replace(/^#/, "").replace(/^\/?/, "/");
  const parts = clean.split("/").filter(Boolean);
  if (parts[0] === "case" && parts[1]) return { name: "case", id: parts[1] };
  if (parts[0] === "runs") return { name: "runs" };
  if (parts[0] === "baselines") return { name: "baselines" };
  if (parts[0] === "settings") return { name: "settings" };
  return { name: "timeline" };
}

function navigateTo(to: string): void {
  const target = to.startsWith("#") ? to : `#${to}`;
  if (window.location.hash === target) return;
  window.location.hash = target;
}

function routeTitle(route: Route): string {
  switch (route.name) {
    case "case":
      return "Case file";
    case "runs":
      return "Runs";
    case "baselines":
      return "Baselines";
    case "settings":
      return "Settings";
    default:
      return "Timeline";
  }
}

function storeSubtitle(boot: Bootstrap): string {
  const active = boot.store.activeBaseline;
  return `${boot.store.home} · ${boot.store.stats.snapshots} snapshots${
    active ? ` · baseline ${active.snapshotId}` : " · no baseline"
  }`;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function confidenceClass(confidence: "high" | "medium" | "low"): string {
  return confidence === "high" ? "high" : confidence === "medium" ? "medium" : "low";
}

function formatValue(value: JsonValue | undefined): string {
  if (value === null || value === undefined) return "(unset)";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => formatValue(item)).join(" ; ");
  }
  if (typeof value === "object") {
    if (value.secret === true) return "<redacted>";
    return JSON.stringify(value);
  }
  return String(value);
}

function truncate(input: string, max: number): string {
  return input.length > max ? `${input.slice(0, max)}…` : input;
}

function formatAgo(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp);
  if (diff < 45_000) return "just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(timestamp);
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dayLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "Today";
  return date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

export type { Json, PublicConfig, RunSummary, SnapshotBrief, SnapshotMeta };
