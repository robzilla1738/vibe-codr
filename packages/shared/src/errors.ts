/** Base error for all vibe-codr failures, carrying a stable `code`. */
export class VibeError extends Error {
  readonly code: string;
  constructor(message: string, code = "VIBE_ERROR") {
    super(message);
    this.name = "VibeError";
    this.code = code;
  }
}

/** Raised when a model string can't be resolved to a provider/model. */
export class ModelResolutionError extends VibeError {
  constructor(modelString: string, detail?: string) {
    super(
      `Cannot resolve model "${modelString}"${detail ? `: ${detail}` : ""}`,
      "MODEL_RESOLUTION",
    );
    this.name = "ModelResolutionError";
  }
}

/** Raised when a provider is referenced but has no credentials configured. */
export class ProviderAuthError extends VibeError {
  constructor(providerId: string, envVars: string[]) {
    super(
      `Provider "${providerId}" is not configured. Set one of: ${envVars.join(", ")}`,
      "PROVIDER_AUTH",
    );
    this.name = "ProviderAuthError";
  }
}

/** Raised when a side-effecting tool is invoked while in plan mode. */
export class PlanModeViolationError extends VibeError {
  constructor(toolName: string) {
    super(
      `Tool "${toolName}" performs side effects and is blocked in plan mode.`,
      "PLAN_MODE_VIOLATION",
    );
    this.name = "PlanModeViolationError";
  }
}

/** Raised when a tool call is denied by the permission layer. */
export class PermissionDeniedError extends VibeError {
  constructor(toolName: string, reason?: string) {
    super(`Permission denied for "${toolName}"${reason ? `: ${reason}` : ""}`, "PERMISSION_DENIED");
    this.name = "PermissionDeniedError";
  }
}

/** Raised when configuration fails validation. */
export class ConfigError extends VibeError {
  constructor(message: string) {
    super(message, "CONFIG");
    this.name = "ConfigError";
  }
}
