import { Sparkles } from "lucide-react";
import type { SessionSkillsResponse } from "@codex-deck/api";
import RightPaneCatalog from "./right-pane-catalog";

export default function SkillsPane(props: {
  data: SessionSkillsResponse | null;
  loading: boolean;
  error: string | null;
  updatingPath: string | null;
  onSelect: (path: string) => void;
  onRefresh: () => void;
  onToggle: (path: string, enabled: boolean) => void;
}) {
  const skills = props.data?.skills ?? [];
  return (
    <RightPaneCatalog
      label="Skills"
      icon={<Sparkles size={18} aria-hidden="true" />}
      loading={props.loading}
      error={props.error}
      onRefresh={props.onRefresh}
      onSelect={props.onSelect}
      filters={[
        { value: "all", label: "All", matches: () => true },
        {
          value: "enabled",
          label: "Enabled",
          matches: (item) => item.tone === "active",
        },
        {
          value: "disabled",
          label: "Disabled",
          matches: (item) => item.tone === "muted",
        },
      ]}
      notices={props.data?.errors.map((error, index) => (
        <div key={index} role="alert" className="right-pane-catalog__notice">
          <strong>{error.path}</strong>
          <br />
          {error.message}
        </div>
      ))}
      items={skills.map((skill) => ({
        key: skill.path,
        title: skill.interface?.displayName?.trim() || skill.name,
        description:
          skill.interface?.shortDescription?.trim() ||
          skill.shortDescription?.trim() ||
          skill.description,
        meta: skill.scope,
        status: skill.enabled ? "Enabled" : "Disabled",
        tone: skill.enabled ? "active" : "muted",
        searchText: [
          skill.name,
          skill.interface?.displayName,
          skill.description,
          skill.shortDescription,
          skill.interface?.shortDescription,
          skill.scope,
          skill.path,
        ].join(" "),
      }))}
      renderDetails={(path) => {
        const skill = skills.find((entry) => entry.path === path)!;
        const saving = props.updatingPath === path;
        return (
          <>
            <div className="right-pane-catalog__identity">
              <span className="right-pane-catalog__hero right-pane-catalog__icon--skills">
                <Sparkles size={24} aria-hidden="true" />
              </span>
              <div>
                <h2>{skill.interface?.displayName?.trim() || skill.name}</h2>
                <span className="right-pane-catalog__subtitle">
                  {skill.name}
                </span>
              </div>
            </div>
            <div className="right-pane-catalog__enable-row">
              <span
                className="right-pane-catalog__status"
                data-tone={skill.enabled ? "active" : "muted"}
              >
                {skill.enabled ? "Enabled" : "Disabled"}
              </span>
              <button
                type="button"
                className="right-pane-catalog__button"
                disabled={props.updatingPath !== null}
                onClick={() => props.onToggle(path, !skill.enabled)}
              >
                {saving
                  ? "Saving…"
                  : skill.enabled
                    ? "Disable skill"
                    : "Enable skill"}
              </button>
            </div>
            <p className="right-pane-catalog__prose">{skill.description}</p>
            <dl className="right-pane-catalog__properties">
              <div>
                <dt>Scope</dt>
                <dd className="capitalize">{skill.scope}</dd>
              </div>
              <div>
                <dt>Path</dt>
                <dd>{skill.path}</dd>
              </div>
            </dl>
            {skill.interface?.defaultPrompt ? (
              <section className="right-pane-catalog__section">
                <h3>Default prompt</h3>
                <pre>{skill.interface.defaultPrompt}</pre>
              </section>
            ) : null}
            {skill.dependencies?.tools.length ? (
              <section className="right-pane-catalog__section">
                <h3>Dependencies</h3>
                {skill.dependencies.tools.map((tool) => (
                  <div
                    className="right-pane-catalog__dependency"
                    key={`${tool.type}:${tool.value}`}
                  >
                    <strong>{tool.value}</strong>
                    <span className="right-pane-catalog__subtitle">
                      {tool.type}
                    </span>
                    {tool.description ? <p>{tool.description}</p> : null}
                  </div>
                ))}
              </section>
            ) : null}
          </>
        );
      }}
    />
  );
}
