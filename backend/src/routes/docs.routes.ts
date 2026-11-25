import { Router, type Request, type Response, type NextFunction } from "express";
import swaggerUi from "swagger-ui-express";
import { openApiSpec } from "../docs/openapi.js";

/**
 * Interactive OpenAPI documentation router (issue #510).
 *
 * Served at /api/docs in development only — never in production. The mount
 * in app.ts is conditional on isDocsEnabled(), and this router also guards
 * every request itself, so the docs can never leak through a mis-mount or a
 * NODE_ENV change after startup.
 *
 * - GET /api/docs        Swagger UI (HTML)
 * - GET /api/docs/docs.json  the raw OpenAPI 3.0 document (what Swagger UI loads)
 */
export function isDocsEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}

function requireDocsEnabled(req: Request, res: Response, next: NextFunction): void {
  if (!isDocsEnabled()) {
    res.status(404).json({ success: false, message: "Not found" });
    return;
  }
  next();
}

export function createDocsRouter(): Router {
  const router = Router();

  router.use(requireDocsEnabled);

  router.get("/docs.json", (_req: Request, res: Response) => {
    res.json(openApiSpec);
  });

  router.use("/", swaggerUi.serve, swaggerUi.setup(openApiSpec));

  return router;
}

export const docsRouter = createDocsRouter();
