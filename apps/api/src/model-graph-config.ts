export class ModelGraphConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelGraphConfigurationError";
  }
}

export function modelGraphApiEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  const configured = environment.ODF_MODEL_GRAPH_API_ENABLED?.trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  if (configured !== undefined && configured !== "") {
    throw new ModelGraphConfigurationError("ODF_MODEL_GRAPH_API_ENABLED must be true or false");
  }
  if (environment.NODE_ENV === "production") {
    throw new ModelGraphConfigurationError(
      "ODF_MODEL_GRAPH_API_ENABLED must be explicitly true or false in production",
    );
  }
  return true;
}
