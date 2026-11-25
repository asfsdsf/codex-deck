import { Terminal } from "lucide-react";
import { useProcessRefreshSettings } from "../hooks/use-process-refresh-settings";
import { useProcesses } from "../hooks/use-processes";
import type { ProcessConnectionMode } from "../process-refresh-settings";
import RightPaneCatalog from "./right-pane-catalog";
import { AnsiText } from "./tool-renderers/ansi-text";

export default function ProcessPane({
  threadId,
  connectionMode,
}: {
  threadId: string;
  connectionMode: ProcessConnectionMode;
}) {
  const { settings } = useProcessRefreshSettings();
  const intervalMs = settings[connectionMode];
  const {
    processes,
    loading,
    error,
    setSelectedId,
    output,
    outputError,
    refresh,
  } = useProcesses(threadId, intervalMs);

  return (
    <div className="right-pane-process">
      <RightPaneCatalog
        label="Process"
        icon={<Terminal size={18} aria-hidden="true" />}
        loading={loading}
        error={error}
        onRefresh={refresh}
        onSelect={setSelectedId}
        onBack={() => setSelectedId(null)}
        filters={[
          { value: "all", label: "All", matches: () => true },
          {
            value: "running",
            label: "Running",
            matches: (item) => item.tone === "active",
          },
          {
            value: "finished",
            label: "Finished",
            matches: (item) => item.tone === "muted",
          },
        ]}
        items={processes.map((run) => ({
          key: run.processId,
          title: run.command,
          description: run.terminal?.cwd || "Background command",
          meta: `Process ${run.processId}`,
          status: run.isRunning ? "Running" : "Finished",
          tone: run.isRunning ? "active" : "muted",
          searchText: `${run.command} ${run.processId} ${run.terminal?.cwd ?? ""}`,
        }))}
        renderDetails={(id) => {
          const run = processes.find((process) => process.processId === id)!;
          const terminal = run.terminal;
          return (
            <>
              <div className="right-pane-catalog__identity">
                <span className="right-pane-catalog__hero right-pane-catalog__icon--process">
                  <Terminal size={24} aria-hidden="true" />
                </span>
                <div>
                  <h2>{run.command}</h2>
                  <span className="right-pane-catalog__subtitle">
                    Process {run.processId}
                  </span>
                </div>
              </div>
              <div className="right-pane-catalog__enable-row">
                <span
                  className="right-pane-catalog__status"
                  data-tone={run.isRunning ? "active" : "muted"}
                >
                  {run.isRunning ? "Running" : "Finished"}
                </span>
              </div>
              <dl className="right-pane-catalog__properties">
                {terminal?.cwd ? (
                  <div>
                    <dt>Working directory</dt>
                    <dd>{terminal.cwd}</dd>
                  </div>
                ) : null}
                {terminal?.osPid != null ? (
                  <div>
                    <dt>OS PID</dt>
                    <dd>{terminal.osPid}</dd>
                  </div>
                ) : null}
                {terminal?.cpuPercent != null ? (
                  <div>
                    <dt>CPU</dt>
                    <dd>{terminal.cpuPercent}%</dd>
                  </div>
                ) : null}
                {terminal?.rssKb != null ? (
                  <div>
                    <dt>Memory</dt>
                    <dd>{(terminal.rssKb / 1024).toFixed(1)} MB</dd>
                  </div>
                ) : null}
              </dl>
              <section className="right-pane-catalog__section">
                <h3>Output</h3>
                {outputError ? (
                  <div role="alert" className="right-pane-catalog__notice">
                    {outputError}
                  </div>
                ) : null}
                {output ? (
                  output.output ? (
                    <pre
                      className="right-pane-process__output"
                      aria-label="Process output"
                    >
                      <AnsiText text={output.output} />
                    </pre>
                  ) : (
                    <p className="right-pane-catalog__prose">
                      No output captured yet.
                    </p>
                  )
                ) : !outputError ? (
                  <p className="right-pane-catalog__prose" role="status">
                    Loading process output…
                  </p>
                ) : null}
              </section>
            </>
          );
        }}
      />
      <div className="right-pane-process__footer">
        {connectionMode === "remote" ? "Remote" : "Local"} · Refresh every{" "}
        {intervalMs / 1000}s
      </div>
    </div>
  );
}
