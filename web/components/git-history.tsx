/** Render Git's lane geometry as a graph, keeping commit text in the layout. */
export default function GitHistory({ lines }: { lines: string[] }) {
  return (
    <div className="right-pane__git-history" aria-label="Commit history">
      {lines.map((line, index) => {
        const match = /^([*|/\\\s]*)([a-f\d]{7,})(?: \((.*?)\))? (.*)$/.exec(
          line,
        );
        const lanes = match?.[1] ?? line;
        return (
          <div
            className="right-pane__history-row"
            key={`${index}:${line}`}
            title={match ? `${match[2]} ${match[4]}` : undefined}
          >
            <svg
              width={Math.max(22, lanes.length * 6 + 8)}
              height={28}
              aria-hidden="true"
            >
              {[...lanes].map((symbol, lane) => {
                const x = 10 + lane * 6;
                const color = ["#4176e6", "#20ae72", "#e1a12a", "#c473d1"][
                  Math.floor(lane / 2) % 4
                ];
                if (symbol === " ") return null;
                return (
                  <g key={lane} stroke={color} strokeWidth={1.5} fill="none">
                    {symbol === "*" || symbol === "|" ? (
                      <path d={`M${x} 0V28`} />
                    ) : null}
                    {symbol === "/" ? (
                      <path
                        d={`M${x + 6} 0C${x + 6} 14 ${x - 6} 14 ${x - 6} 28`}
                      />
                    ) : null}
                    {symbol === "\\" ? (
                      <path
                        d={`M${x - 6} 0C${x - 6} 14 ${x + 6} 14 ${x + 6} 28`}
                      />
                    ) : null}
                    {symbol === "*" ? (
                      <circle cx={x} cy={14} r={3} fill={color} />
                    ) : null}
                  </g>
                );
              })}
            </svg>
            {match ? (
              <>
                <span className="right-pane__history-subject">{match[4]}</span>
                {match[3] ? (
                  <span className="right-pane__history-refs">
                    {match[3].replace("HEAD -> ", "")}
                  </span>
                ) : null}
                <code>{match[2]}</code>
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
