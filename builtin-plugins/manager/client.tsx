import PluginsAdmin from "../../web/components/plugins-admin";
import type { BuiltinViewProps } from "../client-types";
export default function View({ context, homeId }: BuiltinViewProps) {
  return (
    <PluginsAdmin
      homeId={homeId}
      threadId={context.threadId}
      cwd={context.cwd}
    />
  );
}
