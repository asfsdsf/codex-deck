import type { ReactNode } from "react";
export default function EmptyState(props: {
  text: string;
  children?: ReactNode;
}) {
  return (
    <div className="right-pane__empty">
      <span>{props.text}</span>
      {props.children}
    </div>
  );
}
