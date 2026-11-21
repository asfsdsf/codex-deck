# Release Notes example

Open **Plugins** and choose **Import plugin folder**, then select this directory.
Review the manifest, panel HTML, module, and stylesheet before confirming the
installation. The example reads the selected thread and project path, then
saves a sample note using the declared `context.read`, `state.read`, and
`state.write` capabilities.

This is a browser-only plugin package. Its module is served as a relative local
file inside the sandboxed panel iframe; it does not need a build step or an npm
manifest.
