export interface EditableCodexHome {
  id: string;
  label: string;
  path: string;
}

export interface EditableRemoteConfig {
  serverUrl: string;
  username: string;
  password: string;
  setupToken: string;
  machineId: string;
  pinnedRealmId: string;
  pinnedOpaqueServerKey: string;
}

export interface EditableCodexDeckConfig {
  port: string;
  dir: string;
  dev: boolean | null;
  open: boolean | null;
  translationCommand: string;
  codexHomes: EditableCodexHome[];
  remote: EditableRemoteConfig;
}

interface TomlSection {
  tableName: string | null;
  lines: string[];
}

const REMOTE_KEYS = {
  server_url: "serverUrl",
  username: "username",
  password: "password",
  setup_token: "setupToken",
  machine_id: "machineId",
  pinned_realm_id: "pinnedRealmId",
  pinned_opaque_server_key: "pinnedOpaqueServerKey",
} as const satisfies Record<string, keyof EditableRemoteConfig>;

function emptyRemoteConfig(): EditableRemoteConfig {
  return {
    serverUrl: "",
    username: "",
    password: "",
    setupToken: "",
    machineId: "",
    pinnedRealmId: "",
    pinnedOpaqueServerKey: "",
  };
}

export function createEmptyCodexDeckConfig(): EditableCodexDeckConfig {
  return {
    port: "",
    dir: "",
    dev: null,
    open: null,
    translationCommand: "",
    codexHomes: [],
    remote: emptyRemoteConfig(),
  };
}

function parseTomlString(rawValue: string): string | undefined {
  const trimmed = rawValue.trim();
  if (!trimmed.startsWith('"')) {
    return undefined;
  }
  let result = "";
  let escaped = false;
  for (let index = 1; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (escaped) {
      result +=
        character === "n"
          ? "\n"
          : character === "t"
            ? "\t"
            : character === "r"
              ? "\r"
              : character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      return result;
    }
    result += character;
  }
  return undefined;
}

function parseTomlBoolean(rawValue: string): boolean | undefined {
  const normalized = rawValue.trim().split(/\s+#/, 1)[0]?.trim();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return undefined;
}

export function parseCodexDeckConfigContent(
  content: string,
): EditableCodexDeckConfig {
  const config = createEmptyCodexDeckConfig();
  let tableName = "";
  const homes = new Map<string, EditableCodexHome>();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const tableMatch = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (tableMatch?.[1]) {
      tableName = tableMatch[1];
      continue;
    }
    const keyValueMatch = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!keyValueMatch?.[1]) {
      continue;
    }
    const key = keyValueMatch[1];
    const rawValue = keyValueMatch[2] ?? "";

    if (!tableName) {
      if (key === "port") {
        const portMatch = /^[+-]?\d+/.exec(rawValue.trim());
        if (portMatch) {
          config.port = portMatch[0];
        }
      } else if (key === "dir") {
        config.dir = parseTomlString(rawValue) ?? config.dir;
      } else if (key === "dev") {
        config.dev = parseTomlBoolean(rawValue) ?? config.dev;
      } else if (key === "open") {
        config.open = parseTomlBoolean(rawValue) ?? config.open;
      } else if (key === "translation_command") {
        config.translationCommand =
          parseTomlString(rawValue) ?? config.translationCommand;
      }
      continue;
    }

    if (tableName === "remote") {
      const property = REMOTE_KEYS[key as keyof typeof REMOTE_KEYS];
      const value = parseTomlString(rawValue);
      if (property && value !== undefined) {
        config.remote[property] = value;
      }
      continue;
    }

    if (!tableName.startsWith("codex_homes.")) {
      continue;
    }
    const id = tableName.slice("codex_homes.".length);
    if (!id || id.includes(".") || (key !== "path" && key !== "label")) {
      continue;
    }
    const value = parseTomlString(rawValue);
    if (value === undefined) {
      continue;
    }
    const home = homes.get(id) ?? { id, label: "", path: "" };
    home[key] = value;
    homes.set(id, home);
  }

  config.codexHomes = [...homes.values()];
  return config;
}

function splitTomlSections(content: string): TomlSection[] {
  const sections: TomlSection[] = [{ tableName: null, lines: [] }];
  for (const line of content.split(/\r?\n/)) {
    const tableMatch = /^\s*\[([A-Za-z0-9_.-]+)\]\s*$/.exec(line);
    if (tableMatch?.[1]) {
      sections.push({ tableName: tableMatch[1], lines: [line] });
      continue;
    }
    sections[sections.length - 1]?.lines.push(line);
  }
  return sections;
}

function serializeTomlString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")}"`;
}

function updateSectionKeys(
  section: TomlSection,
  values: Record<string, string | undefined>,
): void {
  for (const [key, value] of Object.entries(values)) {
    const assignmentPattern = new RegExp(`^(\\s*)${key}\\s*=`);
    const indexes: number[] = [];
    for (
      let index = section.tableName ? 1 : 0;
      index < section.lines.length;
      index += 1
    ) {
      if (assignmentPattern.test(section.lines[index] ?? "")) {
        indexes.push(index);
      }
    }

    if (value === undefined) {
      for (const index of indexes.reverse()) {
        section.lines.splice(index, 1);
      }
      continue;
    }

    if (indexes.length > 0) {
      const firstIndex = indexes[0] as number;
      const indentation =
        assignmentPattern.exec(section.lines[firstIndex] ?? "")?.[1] ?? "";
      section.lines[firstIndex] = `${indentation}${key} = ${value}`;
      for (const index of indexes.slice(1).reverse()) {
        section.lines.splice(index, 1);
      }
      continue;
    }

    let insertIndex = section.lines.length;
    while (insertIndex > (section.tableName ? 1 : 0)) {
      const previousLine = section.lines[insertIndex - 1];
      if (previousLine?.trim()) {
        break;
      }
      insertIndex -= 1;
    }
    section.lines.splice(insertIndex, 0, `${key} = ${value}`);
  }
}

function optionalString(value: string): string | undefined {
  return value.trim() ? serializeTomlString(value) : undefined;
}

function createHomeSection(home: EditableCodexHome): TomlSection {
  const section: TomlSection = {
    tableName: `codex_homes.${home.id.trim()}`,
    lines: [`[codex_homes.${home.id.trim()}]`],
  };
  updateSectionKeys(section, {
    path: optionalString(home.path),
    label: optionalString(home.label),
  });
  return section;
}

export function updateCodexDeckConfigContent(
  content: string,
  config: EditableCodexDeckConfig,
): string {
  const sections = splitTomlSections(content);
  const rootSection = sections[0] as TomlSection;
  updateSectionKeys(rootSection, {
    port: config.port.trim() || undefined,
    dir: optionalString(config.dir),
    dev: config.dev === null ? undefined : String(config.dev),
    open: config.open === null ? undefined : String(config.open),
    translation_command: optionalString(config.translationCommand),
  });

  let remoteSection = sections.find(
    (section) => section.tableName === "remote",
  );
  const remoteValues: Record<string, string | undefined> = {};
  for (const [key, property] of Object.entries(REMOTE_KEYS)) {
    remoteValues[key] = optionalString(config.remote[property]);
  }
  if (!remoteSection && Object.values(remoteValues).some(Boolean)) {
    remoteSection = { tableName: "remote", lines: ["[remote]"] };
    sections.push(remoteSection);
  }
  if (remoteSection) {
    updateSectionKeys(remoteSection, remoteValues);
  }

  const desiredHomes = new Map(
    config.codexHomes.map((home) => [home.id.trim(), home] as const),
  );
  const usedHomeIds = new Set<string>();
  for (let index = sections.length - 1; index >= 1; index -= 1) {
    const section = sections[index];
    const homeTableMatch = section?.tableName
      ? /^codex_homes\.([A-Za-z0-9_-]+)$/.exec(section.tableName)
      : null;
    if (!homeTableMatch?.[1]) {
      continue;
    }
    const id = homeTableMatch[1];
    const home = desiredHomes.get(id);
    if (!home || usedHomeIds.has(id)) {
      sections.splice(index, 1);
      continue;
    }
    updateSectionKeys(section, {
      path: optionalString(home.path),
      label: optionalString(home.label),
    });
    usedHomeIds.add(id);
  }
  for (const home of config.codexHomes) {
    const id = home.id.trim();
    if (!id || usedHomeIds.has(id)) {
      continue;
    }
    sections.push(createHomeSection(home));
    usedHomeIds.add(id);
  }

  const normalizedSections = sections
    .map((section) => section.lines.join("\n").replace(/\n+$/g, ""))
    .filter((section, index) => index === 0 || section.trim());
  const result = normalizedSections.join("\n\n").replace(/^\n+/, "");
  return result ? `${result}\n` : "";
}
