import express, { type Application } from "express";
import { securityMiddleware, sanitizeInput } from "../src/middleware/security.middleware";

export function createSecurityTestApp(): Application {
  const app = express();

  app.use(securityMiddleware);
  app.use(express.json({ limit: "10mb" }));
  app.use(sanitizeInput);
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.post("/echo", (req, res) => res.json({ data: req.body }));

  return app;
}