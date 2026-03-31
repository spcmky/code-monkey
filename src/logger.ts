import winston from "winston";

const SENSITIVE_KEYS = new Set([
  "password",
  "token",
  "secret",
  "apikey",
  "api_key",
  "authorization",
  "pat",
  "credential",
  "credentials",
  "access_token",
  "refresh_token",
  "private_key",
  "secretstring",
  "aws_access_key",
  "aws_secret",
  "github_token",
  "client_secret",
]);

function redactSensitive(obj: unknown, depth = 0): unknown {
  if (depth > 10) return "[MAX_DEPTH]";
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return obj;
  if (typeof obj === "number" || typeof obj === "boolean") return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitive(item, depth + 1));
  }

  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = redactSensitive(value, depth + 1);
      }
    }
    return result;
  }

  return obj;
}

const redactFormat = winston.format((info) => {
  // Redact sensitive fields in metadata
  const redacted = redactSensitive(info) as winston.Logform.TransformableInfo;
  return redacted;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    redactFormat(),
    winston.format.json()
  ),
  defaultMeta: { service: "code-monkey" },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
  ],
});

export default logger;
