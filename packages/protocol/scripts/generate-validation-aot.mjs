import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(packageRoot, "codegen/ws-outbound.compile.ts");
const runtimeSchemaMetadata = resolve(packageRoot, "src/validation/ws-outbound-schema-metadata.ts");
const output = resolve(packageRoot, "src/generated/validation/ws-outbound.aot.ts");

const require = createRequire(import.meta.url);
const zodAotEntry = require.resolve("zod-aot");
const zodAotRoot = resolve(dirname(zodAotEntry), "..");
const emitterPath = resolve(zodAotRoot, "dist/cli/emitter.js");
const discriminatedUnionPath = resolve(
  zodAotRoot,
  "dist/core/codegen/schemas/discriminated-union.js",
);
const unionExtractorPath = resolve(zodAotRoot, "dist/core/extract/extractors/union.js");

async function ensureZodAotRuntimeImportExtensionPatch() {
  const emitter = await readFile(emitterPath, "utf8");
  if (emitter.includes('sourceRelPath.endsWith(".js")')) {
    return;
  }

  const before = 'let importPath = sourceRelPath.replace(/\\.[cm]?[jt]sx?$/, "");';
  const after =
    'let importPath = sourceRelPath.endsWith(".js")\n        ? sourceRelPath\n        : sourceRelPath.replace(/\\.[cm]?[jt]sx?$/, "");';
  if (!emitter.includes(before)) {
    throw new Error("zod-aot emitter shape changed; update the runtime import extension patch");
  }
  await writeFile(emitterPath, emitter.replace(before, after));
}

async function ensureZodAotBooleanDiscriminatorExtractorPatch() {
  let extractor = await readFile(unionExtractorPath, "utf8");
  if (extractor.includes("typeof v +")) {
    return;
  }

  const storeBefore = "mapping[String(v)] = i;";
  const storeAfter = 'mapping[typeof v + ":" + String(v)] = i;';

  if (!extractor.includes(storeBefore)) {
    throw new Error(
      "zod-aot union extractor shape changed; update the boolean discriminator patch",
    );
  }

  extractor = extractor.replace(storeBefore, storeAfter);
  await writeFile(unionExtractorPath, extractor);
}

async function ensureZodAotBooleanDiscriminatorCodegenPatch() {
  let codegen = await readFile(discriminatedUnionPath, "utf8");
  if (codegen.includes("emitCaseValue")) {
    return;
  }

  const helperInsertBefore = "export function slowDiscriminatedUnion(ir, g) {";
  const helperInsertAfter = `function emitCaseValue(typedKey) {
    var sep = typedKey.indexOf(":");
    if (sep === -1) return escapeString(typedKey);
    var t = typedKey.slice(0, sep);
    var v = typedKey.slice(sep + 1);
    if (t === "boolean" || t === "number") return v;
    return escapeString(v);
}
export function slowDiscriminatedUnion(ir, g) {`;

  const slowCaseBefore = "case ${escapeString(value)}:";
  const slowCaseAfter = "case ${emitCaseValue(value)}:";

  const slowOptionsBefore = ".map((v) => escapeString(v))";
  const slowOptionsAfter = ".map((v) => emitCaseValue(v))";

  const fastCaseBefore = "cases.push(`case ${escapeString(value)}:return ${check};`);";
  const fastCaseAfter = "cases.push(`case ${emitCaseValue(value)}:return ${check};`);";

  if (
    !codegen.includes(helperInsertBefore) ||
    !codegen.includes(slowCaseBefore) ||
    !codegen.includes(slowOptionsBefore) ||
    !codegen.includes(fastCaseBefore)
  ) {
    throw new Error(
      "zod-aot discriminated-union codegen shape changed; update the boolean discriminator patch",
    );
  }

  codegen = codegen
    .replace(helperInsertBefore, helperInsertAfter)
    .replace(slowCaseBefore, slowCaseAfter)
    .replace(slowOptionsBefore, slowOptionsAfter)
    .replace(fastCaseBefore, fastCaseAfter);
  await writeFile(discriminatedUnionPath, codegen);
}

async function ensureZodAotDiscriminatedUnionOutputPatch() {
  let discriminatedUnionEmitter = await readFile(discriminatedUnionPath, "utf8");
  if (
    discriminatedUnionEmitter.includes(
      "const needsOutputPropagation = ir.options.some(hasMutation);",
    )
  ) {
    return;
  }

  const importBefore = 'import { escapeString } from "../context.js";';
  const importAfter = 'import { escapeString, hasMutation } from "../context.js";';
  const outputFlagBefore = "const discKey = escapeString(ir.discriminator);\n    let code = emit `";
  const outputFlagAfter =
    "const discKey = escapeString(ir.discriminator);\n    const needsOutputPropagation = ir.options.some(hasMutation);\n    let code = emit `";
  const propagationBefore =
    "        ${g.visit(option, { input: objVar, output: objVar })}\n        break;`;";
  const propagationAfter =
    '        ${g.visit(option, { input: objVar, output: objVar })}\n        ${needsOutputPropagation ? `${g.output}=${objVar};` : ""}\n        break;`;';

  if (
    !discriminatedUnionEmitter.includes(importBefore) ||
    !discriminatedUnionEmitter.includes(outputFlagBefore) ||
    !discriminatedUnionEmitter.includes(propagationBefore)
  ) {
    throw new Error("zod-aot discriminated-union emitter shape changed; update the output patch");
  }

  discriminatedUnionEmitter = discriminatedUnionEmitter
    .replace(importBefore, importAfter)
    .replace(outputFlagBefore, outputFlagAfter)
    .replace(propagationBefore, propagationAfter);
  await writeFile(discriminatedUnionPath, discriminatedUnionEmitter);
}

await Promise.all([
  ensureZodAotRuntimeImportExtensionPatch(),
  ensureZodAotBooleanDiscriminatorExtractorPatch(),
]);
// These two patch the same file — run sequentially to avoid write races.
await ensureZodAotDiscriminatedUnionOutputPatch();
await ensureZodAotBooleanDiscriminatorCodegenPatch();

const [{ discoverSchemas }, { compileSchemas }, { generateCompiledFileContent }] =
  await Promise.all([
    import(pathToFileURL(resolve(zodAotRoot, "dist/discovery.js")).href),
    import(pathToFileURL(resolve(zodAotRoot, "dist/core/pipeline.js")).href),
    import(pathToFileURL(resolve(zodAotRoot, "dist/cli/emitter.js")).href),
  ]);

const schemas = await discoverSchemas(source, { cacheBust: true });
if (schemas.length === 0) {
  throw new Error(`No zod-aot compile() exports found in ${relative(packageRoot, source)}`);
}

const compiled = compileSchemas(schemas, { mode: "inline" });
const runtimeImportPath = relative(dirname(output), runtimeSchemaMetadata)
  .replace(/\.[cm]?[jt]sx?$/, ".js")
  .split(sep)
  .join("/");
const content = generateCompiledFileContent(compiled, runtimeImportPath, {
  zodCompat: false,
}).replace(
  "// AUTO-GENERATED by zod-aot — DO NOT EDIT",
  "// @ts-nocheck\n// AUTO-GENERATED by zod-aot — DO NOT EDIT",
);

await mkdir(dirname(output), { recursive: true });
await writeFile(output, content);

console.info(
  `generated ${relative(packageRoot, output)} from ${relative(packageRoot, source)} (${schemas
    .map((schema) => schema.exportName)
    .join(", ")})`,
);
