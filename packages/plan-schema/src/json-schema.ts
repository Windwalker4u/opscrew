import { z } from "zod";
import { ProviderCatalogueSchema } from "./catalogue";
import { ARTIFACT_FILES, ARTIFACT_KINDS, ARTIFACT_SCHEMAS, type ArtifactKind } from "./io";

const TITLES: Record<ArtifactKind, string> = {
  app: "OpsCrew app record (opscrew/apps/<key>/app.yaml)",
  architecture: "OpsCrew architecture (opscrew/architecture.json)",
  requirements: "OpsCrew requirements (opscrew/requirements.yaml)",
  plan: "OpsCrew deploy plan (opscrew/plan.yaml)",
  credentials: "OpsCrew credential dates (opscrew/credentials.yaml)",
};

/**
 * Draft-07 JSON Schemas for the artefacts, for editors and external tools.
 * Generated in `input` mode: they describe what OpsCrew accepts when reading a file, so fields
 * that have defaults are optional. Cross-field rules are enforced by zod only.
 */
export function toJsonSchemas(): Record<ArtifactKind, object> {
  const out = {} as Record<ArtifactKind, object>;
  for (const kind of ARTIFACT_KINDS) {
    const { $schema, ...rest } = z.toJSONSchema(ARTIFACT_SCHEMAS[kind], {
      target: "draft-7",
      io: "input",
    });
    out[kind] = {
      $schema,
      title: TITLES[kind],
      description: `Schema v1 of ${ARTIFACT_FILES[kind]}. Generated from @opscrew/plan-schema; do not edit.`,
      ...rest,
    };
  }
  return out;
}

/** The catalogue `opscrew providers --json` prints, for the tools that read it. */
export function catalogueJsonSchema(): object {
  const { $schema, ...rest } = z.toJSONSchema(ProviderCatalogueSchema, {
    target: "draft-7",
    io: "output",
  });
  return {
    $schema,
    title: "OpsCrew provider catalogue (opscrew providers --json)",
    description:
      "Catalogue version 1, as `opscrew providers --json` prints it. Generated from @opscrew/plan-schema; do not edit.",
    ...rest,
  };
}

/** A generated schema file's name. */
type SchemaFile = `${ArtifactKind | "provider-catalogue"}.schema.json`;

/** File name and exact contents (2-space JSON, trailing newline) of every generated schema file. */
export function renderJsonSchemaFiles(): Record<SchemaFile, string> {
  const schemas = toJsonSchemas();
  const render = (schema: object) => `${JSON.stringify(schema, null, 2)}\n`;
  const files = {} as Record<SchemaFile, string>;
  for (const kind of ARTIFACT_KINDS) files[`${kind}.schema.json`] = render(schemas[kind]);
  files["provider-catalogue.schema.json"] = render(catalogueJsonSchema());
  return files;
}
