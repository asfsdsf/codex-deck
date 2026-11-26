import { Suspense } from "react";
import { builtinClientModules } from "../../builtin-plugins/client";
import type { BuiltinViewProps } from "../../builtin-plugins/client-types";

export default function BuiltinPluginView({
  pluginId,
  homeId,
  ...props
}: BuiltinViewProps & { pluginId: string }) {
  const Component =
    builtinClientModules[pluginId as keyof typeof builtinClientModules];
  if (!Component)
    return (
      <p className="text-sm text-zinc-500">
        This built-in plugin provides background services.
      </p>
    );
  return (
    <Suspense fallback={<p role="status">Loading plugin…</p>}>
      <Component {...props} homeId={homeId} />
    </Suspense>
  );
}
