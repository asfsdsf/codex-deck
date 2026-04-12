import fastify from "fastify";
import { log, logger } from "@/utils/log";
import {
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider,
} from "fastify-type-provider-zod";
import { onShutdown } from "@/utils/shutdown";
import { Fastify } from "./types";
import { authRoutes } from "./routes/authRoutes";
import { pushRoutes } from "./routes/pushRoutes";
import { sessionRoutes } from "./routes/sessionRoutes";
import { connectRoutes } from "./routes/connectRoutes";
import { accountRoutes } from "./routes/accountRoutes";
import { startSocket } from "./socket";
import { machinesRoutes } from "./routes/machinesRoutes";
import { devRoutes } from "./routes/devRoutes";
import { versionRoutes } from "./routes/versionRoutes";
import { voiceRoutes } from "./routes/voiceRoutes";
import { artifactsRoutes } from "./routes/artifactsRoutes";
import { accessKeysRoutes } from "./routes/accessKeysRoutes";
import { enableMonitoring } from "./utils/enableMonitoring";
import { enableErrorHandlers } from "./utils/enableErrorHandlers";
import { enableAuthentication } from "./utils/enableAuthentication";
import { userRoutes } from "./routes/userRoutes";
import { feedRoutes } from "./routes/feedRoutes";
import { kvRoutes } from "./routes/kvRoutes";
import { v3SessionRoutes } from "./routes/v3SessionRoutes";
import { remoteRoutes } from "./routes/remoteRoutes";
import { isLocalStorage, getLocalFilesDir } from "@/storage/files";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getWebDistPath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "../dist/web"),
    path.resolve(process.cwd(), "dist/web"),
    path.resolve(__dirname, "../../../../dist/web"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "index.html"))) {
      return candidate;
    }
  }
  return null;
}

function injectRemoteBootstrap(html: string, publicUrl: string): string {
  const script = `<script>window.__CODEX_DECK_REMOTE_DEFAULT__ = { enabled: true, serverUrl: ${JSON.stringify(publicUrl)} };</script>`;
  if (html.includes("<head>")) {
    return html.replace("<head>", `<head>${script}`);
  }
  return `${script}${html}`;
}

function getContentTypeForPath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    case ".map":
      return "application/json; charset=utf-8";
    default:
      return null;
  }
}

export async function startApi() {
  // Configure
  log("Starting API...");

  // Start API
  const app = fastify({
    loggerInstance: logger,
    bodyLimit: 1024 * 1024 * 100, // 100MB
  });
  app.register(import("@fastify/cors"), {
    origin: true,
    credentials: true,
    allowedHeaders: "*",
    methods: ["GET", "POST", "PATCH", "DELETE"],
  });
  const webDistPath = getWebDistPath();
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3005;
  const publicUrl = process.env.PUBLIC_URL || `http://localhost:${port}`;

  app.get("/", function (request, reply) {
    if (!webDistPath) {
      reply.send("Welcome to Codex-deck Server!");
      return;
    }
    try {
      const html = fs.readFileSync(
        path.join(webDistPath, "index.html"),
        "utf-8",
      );
      reply.type("text/html").send(injectRemoteBootstrap(html, publicUrl));
    } catch {
      reply
        .code(404)
        .send('Web app not found. Run "pnpm build" from the repo root first.');
    }
  });

  // Create typed provider
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;

  // Enable features
  enableMonitoring(typed);
  enableErrorHandlers(typed);
  enableAuthentication(typed);

  // Serve local files when using local storage
  if (isLocalStorage()) {
    app.get("/files/*", function (request, reply) {
      const filePath = (request.params as any)["*"];
      const baseDir = path.resolve(getLocalFilesDir());
      const fullPath = path.resolve(baseDir, filePath);
      if (!fullPath.startsWith(baseDir + path.sep)) {
        reply.code(403).send("Forbidden");
        return;
      }
      if (!fs.existsSync(fullPath)) {
        reply.code(404).send("Not found");
        return;
      }
      const stream = fs.createReadStream(fullPath);
      reply.send(stream);
    });
  }

  // Routes
  authRoutes(typed);
  pushRoutes(typed);
  sessionRoutes(typed);
  accountRoutes(typed);
  connectRoutes(typed);
  machinesRoutes(typed);
  artifactsRoutes(typed);
  accessKeysRoutes(typed);
  devRoutes(typed);
  versionRoutes(typed);
  voiceRoutes(typed);
  userRoutes(typed);
  feedRoutes(typed);
  kvRoutes(typed);
  v3SessionRoutes(typed);
  remoteRoutes(typed);

  if (webDistPath) {
    app.get("/assets/*", function (request, reply) {
      const filePath = (request.params as any)["*"];
      const baseDir = path.resolve(path.join(webDistPath, "assets"));
      const fullPath = path.resolve(baseDir, filePath);
      if (!fullPath.startsWith(baseDir + path.sep)) {
        reply.code(403).send("Forbidden");
        return;
      }
      if (!fs.existsSync(fullPath)) {
        reply.code(404).send("Not found");
        return;
      }
      const contentType = getContentTypeForPath(fullPath);
      if (contentType) {
        reply.type(contentType);
      }
      reply.send(fs.createReadStream(fullPath));
    });

    app.get("/*", function (request, reply) {
      const routePath = request.url.split("?")[0];
      if (routePath.startsWith("/v1/") || routePath.startsWith("/files/")) {
        reply.code(404).send("Not found");
        return;
      }

      const requestedPath =
        routePath === "/" ? "index.html" : routePath.slice(1);
      const candidatePath = path.resolve(webDistPath, requestedPath);
      if (
        candidatePath.startsWith(webDistPath + path.sep) &&
        fs.existsSync(candidatePath) &&
        fs.statSync(candidatePath).isFile()
      ) {
        const contentType = getContentTypeForPath(candidatePath);
        if (contentType) {
          reply.type(contentType);
        }
        reply.send(fs.createReadStream(candidatePath));
        return;
      }

      try {
        const html = fs.readFileSync(
          path.join(webDistPath, "index.html"),
          "utf-8",
        );
        reply.type("text/html").send(injectRemoteBootstrap(html, publicUrl));
      } catch {
        reply
          .code(404)
          .send(
            'Web app not found. Run "pnpm build" from the repo root first.',
          );
      }
    });
  }

  // Start HTTP
  await app.listen({ port, host: "0.0.0.0" });
  onShutdown("api", async () => {
    await app.close();
  });

  // Start Socket
  startSocket(typed);

  // End
  log("API ready on port http://localhost:" + port);
}
